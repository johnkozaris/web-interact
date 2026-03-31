// @ts-nocheck
import { toClientCertificatesProtocol } from "./browserContext";
import { ChannelOwner } from "./channelOwner";
import { isTargetClosedError, TargetClosedError } from "./errors";
import { RawHeaders } from "./network";
import { Tracing } from "./tracing";
import { assert } from "../utils/isomorphic/assert";
import { readTempFile, writeTempFile } from "./fileUtils";
import { headersObjectToArray } from "../utils/isomorphic/headers";
import { isString } from "../utils/isomorphic/rtti";
import { TimeoutSettings } from "./timeoutSettings";

export class APIRequest {
  constructor(playwright) {
    this._contexts = new Set();
    this._playwright = playwright;
  }

  async newContext(options = {}) {
    options = { ...options };
    await this._playwright._instrumentation.runBeforeCreateRequestContext(options);
    const storageState =
      typeof options.storageState === "string"
        ? JSON.parse(await readTempFile(options.storageState))
        : options.storageState;
    const context = APIRequestContext.from(
      (
        await this._playwright._channel.newRequest({
          ...options,
          extraHTTPHeaders: options.extraHTTPHeaders
            ? headersObjectToArray(options.extraHTTPHeaders)
            : undefined,
          storageState,
          tracesDir: this._playwright._defaultLaunchOptions?.tracesDir,
          clientCertificates: await toClientCertificatesProtocol(
            this._playwright._platform,
            options.clientCertificates
          ),
        })
      ).request
    );
    this._contexts.add(context);
    context._request = this;
    context._timeoutSettings.setDefaultTimeout(
      options.timeout ?? this._playwright._defaultContextTimeout
    );
    context._tracing._tracesDir = this._playwright._defaultLaunchOptions?.tracesDir;
    await context._instrumentation.runAfterCreateRequestContext(context);
    return context;
  }
}

export class APIRequestContext extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }

  constructor(parent, type, guid, initializer) {
    super(parent, type, guid, initializer);
    this._tracing = Tracing.from(initializer.tracing);
    this._timeoutSettings = new TimeoutSettings(this._platform);
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  async dispose(options = {}) {
    this._closeReason = options.reason;
    await this._instrumentation.runBeforeCloseRequestContext(this);
    try {
      await this._channel.dispose(options);
    } catch (error) {
      if (isTargetClosedError(error)) {
        return;
      }
      throw error;
    }
    this._tracing._resetStackCounter();
    this._request?._contexts.delete(this);
  }

  async delete(url, options) {
    return await this.fetch(url, { ...options, method: "DELETE" });
  }

  async head(url, options) {
    return await this.fetch(url, { ...options, method: "HEAD" });
  }

  async get(url, options) {
    return await this.fetch(url, { ...options, method: "GET" });
  }

  async patch(url, options) {
    return await this.fetch(url, { ...options, method: "PATCH" });
  }

  async post(url, options) {
    return await this.fetch(url, { ...options, method: "POST" });
  }

  async put(url, options) {
    return await this.fetch(url, { ...options, method: "PUT" });
  }

  async fetch(urlOrRequest, options = {}) {
    const url = isString(urlOrRequest) ? urlOrRequest : undefined;
    const request = isString(urlOrRequest) ? undefined : urlOrRequest;
    return await this._innerFetch({ url, request, ...options });
  }

  async _innerFetch(options = {}) {
    return await this._wrapApiCall(async () => {
      if (this._closeReason) {
        throw new TargetClosedError(this._closeReason);
      }

      assert(
        options.request || typeof options.url === "string",
        "First argument must be either URL string or Request"
      );
      assert(
        (options.data === undefined ? 0 : 1) +
          (options.form === undefined ? 0 : 1) +
          (options.multipart === undefined ? 0 : 1) <=
          1,
        "Only one of 'data', 'form' or 'multipart' can be specified"
      );
      assert(
        options.maxRedirects === undefined || options.maxRedirects >= 0,
        "'maxRedirects' must be greater than or equal to '0'"
      );
      assert(
        options.maxRetries === undefined || options.maxRetries >= 0,
        "'maxRetries' must be greater than or equal to '0'"
      );

      const url = options.url !== undefined ? options.url : options.request.url();
      this._checkUrlAllowed?.(url);

      const method = options.method || options.request?.method();
      let encodedParams = undefined;
      if (typeof options.params === "string") {
        encodedParams = options.params;
      } else if (options.params instanceof URLSearchParams) {
        encodedParams = options.params.toString();
      }

      const headersObj = options.headers || options.request?.headers();
      const headers = headersObj ? headersObjectToArray(headersObj) : undefined;
      let jsonData;
      let formData;
      let multipartData;
      let postDataBuffer;

      if (options.data !== undefined) {
        if (isString(options.data)) {
          if (isJsonContentType(headers)) {
            jsonData = isJsonParsable(options.data) ? options.data : JSON.stringify(options.data);
          } else {
            postDataBuffer = Buffer.from(options.data, "utf8");
          }
        } else if (Buffer.isBuffer(options.data)) {
          postDataBuffer = options.data;
        } else if (
          typeof options.data === "object" ||
          typeof options.data === "number" ||
          typeof options.data === "boolean"
        ) {
          jsonData = JSON.stringify(options.data);
        } else {
          throw new Error("Unexpected 'data' type");
        }
      } else if (options.form) {
        if (globalThis.FormData && options.form instanceof FormData) {
          formData = [];
          for (const [name, value] of options.form.entries()) {
            if (typeof value !== "string") {
              throw new Error(
                `Expected string for options.form["${name}"], found File. Please use options.multipart instead.`
              );
            }
            formData.push({ name, value });
          }
        } else {
          formData = objectToArray(options.form);
        }
      } else if (options.multipart) {
        multipartData = [];
        if (globalThis.FormData && options.multipart instanceof FormData) {
          const form = options.multipart;
          for (const [name, value] of form.entries()) {
            if (isString(value)) {
              multipartData.push({ name, value });
            } else {
              const file = {
                name: value.name,
                mimeType: value.type,
                buffer: Buffer.from(await value.arrayBuffer()),
              };
              multipartData.push({ name, file });
            }
          }
        } else {
          for (const [name, value] of Object.entries(options.multipart)) {
            multipartData.push(await toFormField(this._platform, name, value));
          }
        }
      }

      if (
        postDataBuffer === undefined &&
        jsonData === undefined &&
        formData === undefined &&
        multipartData === undefined
      ) {
        postDataBuffer = options.request?.postDataBuffer() || undefined;
      }

      const result = await this._channel.fetch({
        url,
        params: typeof options.params === "object" ? objectToArray(options.params) : undefined,
        encodedParams,
        method,
        headers,
        postData: postDataBuffer,
        jsonData,
        formData,
        multipartData,
        timeout: this._timeoutSettings.timeout(options),
        failOnStatusCode: options.failOnStatusCode,
        ignoreHTTPSErrors: options.ignoreHTTPSErrors,
        maxRedirects: options.maxRedirects,
        maxRetries: options.maxRetries,
        __testHookLookup: options.__testHookLookup,
      });
      return new APIResponse(this, result.response);
    });
  }

  async storageState(options = {}) {
    const state = await this._channel.storageState({ indexedDB: options.indexedDB });
    if (options.path) {
      await writeTempFile(options.path, JSON.stringify(state, undefined, 2));
    }
    return state;
  }
}

async function toFormField(platform, name, value) {
  const typeOfValue = typeof value;
  if (isFilePayload(value)) {
    const payload = value;
    if (!Buffer.isBuffer(payload.buffer)) {
      throw new Error(`Unexpected buffer type of 'data.${name}'`);
    }
    return { name, file: filePayloadToJson(payload) };
  }
  if (typeOfValue === "string" || typeOfValue === "number" || typeOfValue === "boolean") {
    return { name, value: String(value) };
  }
  return { name, file: await readStreamToJson(platform, value) };
}

function isJsonParsable(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}

export class APIResponse {
  constructor(context, initializer) {
    this._request = context;
    this._initializer = initializer;
    this._headers = new RawHeaders(this._initializer.headers);
    if (context._platform.inspectCustom) {
      this[context._platform.inspectCustom] = () => this._inspect();
    }
  }

  ok() {
    return this._initializer.status >= 200 && this._initializer.status <= 299;
  }

  url() {
    return this._initializer.url;
  }

  status() {
    return this._initializer.status;
  }

  statusText() {
    return this._initializer.statusText;
  }

  headers() {
    return this._headers.headers();
  }

  headersArray() {
    return this._headers.headersArray();
  }

  async body() {
    return await this._request._wrapApiCall(async () => {
      try {
        const result = await this._request._channel.fetchResponseBody({
          fetchUid: this._fetchUid(),
        });
        if (result.binary === undefined) {
          throw new Error("Response has been disposed");
        }
        return result.binary;
      } catch (error) {
        if (isTargetClosedError(error)) {
          throw new Error("Response has been disposed");
        }
        throw error;
      }
    }, { internal: true });
  }

  async text() {
    return (await this.body()).toString("utf8");
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  async dispose() {
    await this._request._channel.disposeAPIResponse({ fetchUid: this._fetchUid() });
  }

  _inspect() {
    const headers = this.headersArray().map(({ name, value }) => `  ${name}: ${value}`);
    return `APIResponse: ${this.status()} ${this.statusText()}
${headers.join("\n")}`;
  }

  _fetchUid() {
    return this._initializer.fetchUid;
  }

  async _fetchLog() {
    const { log } = await this._request._channel.fetchLog({ fetchUid: this._fetchUid() });
    return log;
  }
}

function filePayloadToJson(payload) {
  return {
    name: payload.name,
    mimeType: payload.mimeType,
    buffer: payload.buffer,
  };
}

async function readStreamToJson(platform, stream) {
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  const streamPath = Buffer.isBuffer(stream.path) ? stream.path.toString("utf8") : stream.path;
  return {
    name: platform.path().basename(streamPath),
    buffer,
  };
}

function isJsonContentType(headers) {
  if (!headers) {
    return false;
  }
  for (const { name, value } of headers) {
    if (name.toLocaleLowerCase() === "content-type") {
      return value === "application/json";
    }
  }
  return false;
}

function objectToArray(map) {
  if (!map) {
    return undefined;
  }
  const result = [];
  for (const [name, value] of Object.entries(map)) {
    if (value !== undefined) {
      result.push({ name, value: String(value) });
    }
  }
  return result;
}

function isFilePayload(value) {
  return typeof value === "object" && value?.name && value?.mimeType && value?.buffer;
}
