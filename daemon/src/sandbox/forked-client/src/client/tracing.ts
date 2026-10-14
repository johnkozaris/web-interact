// @ts-nocheck
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { isRegExp, isString } from "../utils/isomorphic/rtti";
import { Artifact } from "./artifact";
import { ChannelOwner } from "./channelOwner";
import { DisposableStub } from "./disposable";
import { resolveTempFilePath } from "./fileUtils";
import { kNoTimeout } from "./timeoutSettings";

import type { Page } from "./page";
import type * as api from "../../types/types";
import type * as channels from "../protocol/channels";

export class Tracing extends ChannelOwner<channels.TracingChannel> implements api.Tracing {
  private _includeSources = false;
  private _additionalSources = new Set<string>();
  private _isLive = false;
  _tracesDir: string | undefined;
  private _stacksId: string | undefined;
  private _isTracing = false;
  private _harId: string | undefined;
  private _harRecorders = new Map<string, { path: string; resourcesDir?: string }>();

  static from(channel: channels.TracingChannel): Tracing {
    return (channel as any)._object;
  }

  constructor(
    parent: ChannelOwner,
    type: string,
    guid: string,
    initializer: channels.TracingInitializer
  ) {
    super(parent, type, guid, initializer);
  }

  async start(
    options: {
      name?: string;
      title?: string;
      snapshots?: boolean | { dom?: boolean; aria?: boolean; screen?: boolean };
      screenshots?: boolean;
      _coverage?: boolean;
      sources?: boolean;
      live?: boolean;
    } = {}
  ) {
    await this._wrapApiCall(async () => {
      this._includeSources = !!options.sources;
      this._isLive = !!options.live;
      const snapshots =
        typeof options.snapshots === "object" ? options.snapshots : { dom: options.snapshots };
      await this._channel.tracingStart(
        {
          name: options.name,
          snapshotDom: snapshots.dom,
          snapshotAria: snapshots.aria,
          snapshotScreen: snapshots.screen,
          screencast: options.screenshots,
          coverage: options._coverage,
          live: options.live,
        },
        kNoTimeout
      );
      const { traceName } = await this._channel.tracingStartChunk(
        { name: options.name, title: options.title },
        kNoTimeout
      );
      await this._startCollectingStacks(traceName, this._isLive);
    });
    return new DisposableStub(() => this.stop());
  }

  async startChunk(options: { name?: string; title?: string } = {}) {
    await this._wrapApiCall(async () => {
      const { traceName } = await this._channel.tracingStartChunk(options, kNoTimeout);
      await this._startCollectingStacks(traceName, this._isLive);
    });
    return new DisposableStub(() => this.stopChunk());
  }

  async group(
    name: string,
    options: { location?: { file: string; line?: number; column?: number } } = {}
  ) {
    if (options.location) this._additionalSources.add(options.location.file);
    await this._channel.tracingGroup({ name, location: options.location }, kNoTimeout);
    return new DisposableStub(() => this.groupEnd());
  }

  async groupEnd() {
    await this._channel.tracingGroupEnd({}, kNoTimeout);
  }

  private async _startCollectingStacks(traceName: string, live: boolean) {
    if (!this._isTracing) {
      this._isTracing = true;
      this._connection.setIsTracing(true);
    }
    const result = await this._connection
      .localUtils()
      ?.tracingStarted({ tracesDir: this._tracesDir, traceName, live });
    this._stacksId = result?.stacksId;
  }

  async stopChunk(options: { path?: string } = {}) {
    await this._wrapApiCall(async () => {
      await this._doStopChunk(options.path);
    });
  }

  async stop(options: { path?: string } = {}) {
    await this._wrapApiCall(async () => {
      const error = await this._doStopChunk(options.path).catch((e) => e);
      await this._channel.tracingStop({}, kNoTimeout);
      if (error) throw error;
    });
  }

  async startHar(
    path: string,
    options: {
      content?: "embed" | "attach" | "omit";
      mode?: "full" | "minimal";
      urlFilter?: string | RegExp;
      resourcesDir?: string;
    } = {}
  ) {
    await this._wrapApiCall(async () => {
      if (this._harId) throw new Error("HAR recording has already been started");
      if (options.resourcesDir && path.endsWith(".zip"))
        throw new Error("resourcesDir option is not compatible with a .zip har file");
      const defaultContent = path.endsWith(".zip") ? "attach" : "embed";
      this._harId = await this._recordIntoHAR(path, null, {
        url: options.urlFilter,
        updateContent: options.content ?? defaultContent,
        updateMode: options.mode ?? "full",
        resourcesDir: options.resourcesDir,
      });
    });
    return new DisposableStub(() => this.stopHar());
  }

  async stopHar() {
    await this._wrapApiCall(async () => {
      const harId = this._harId;
      if (!harId) throw new Error("HAR recording has not been started");
      this._harId = undefined;
      await this._exportHAR(harId);
    });
  }

  async _recordIntoHAR(
    har: string,
    page: Page | null,
    options: {
      url?: string | RegExp;
      updateContent?: "attach" | "embed" | "omit";
      updateMode?: "minimal" | "full";
      resourcesDir?: string;
    } = {}
  ): Promise<string> {
    const isZip = har.endsWith(".zip");
    // The server writes an uncompressed HAR straight to harPath, so the sandbox
    // only ever hands it paths resolved inside the sandbox's temp area.
    const { harId } = await this._channel.harStart(
      {
        page: page?._channel,
        options: {
          content: options.updateContent ?? "attach",
          urlGlob: isString(options.url) ? options.url : undefined,
          urlRegexSource: isRegExp(options.url) ? options.url.source : undefined,
          urlRegexFlags: isRegExp(options.url) ? options.url.flags : undefined,
          mode: options.updateMode ?? "minimal",
          harPath: isZip ? undefined : await resolveTempFilePath(har),
          resourcesDir: options.resourcesDir
            ? await resolveTempFilePath(options.resourcesDir)
            : undefined,
        },
      },
      kNoTimeout
    );
    this._harRecorders.set(harId, { path: har, resourcesDir: options.resourcesDir });
    return harId;
  }

  async _exportHAR(harId: string): Promise<void> {
    const harParams = this._harRecorders.get(harId);
    if (!harParams) return;
    this._harRecorders.delete(harId);
    if (!harParams.path.endsWith(".zip")) {
      // The server already wrote the HAR to its resolved temp path.
      await this._channel.harExport({ harId, mode: "entries" }, kNoTimeout);
      return;
    }
    // Zipping happens in LocalUtils upstream, which the sandbox lacks, so a
    // zipped HAR comes back as an archive artifact saved into the temp area.
    const { artifact: artifactChannel } = await this._channel.harExport(
      { harId, mode: "archive" },
      kNoTimeout
    );
    const artifact = Artifact.from(artifactChannel!);
    await artifact.saveAs(harParams.path);
    await artifact.delete();
  }

  async _exportAllHars(): Promise<void> {
    await this._wrapApiCall(
      async () => {
        await Promise.all([...this._harRecorders.keys()].map((harId) => this._exportHAR(harId)));
      },
      { internal: true }
    );
  }

  private async _doStopChunk(filePath: string | undefined) {
    this._resetStackCounter();

    const additionalSources = [...this._additionalSources];
    this._additionalSources.clear();
    const stacksId = this._stacksId;
    this._stacksId = undefined;

    try {
      await this._saveChunk(filePath, stacksId, additionalSources);
    } catch (error) {
      // Release the stack session even on failure, otherwise later traces keep appending to it.
      if (stacksId)
        await this._connection
          .localUtils()
          ?.traceDiscarded({ stacksId })
          .catch(() => {});
      throw error;
    }
  }

  private async _saveChunk(
    filePath: string | undefined,
    stacksId: string | undefined,
    additionalSources: string[]
  ) {
    void stacksId;
    void additionalSources;
    if (!filePath) {
      // Not interested in artifacts.
      await this._channel.tracingStopChunk({ mode: "discard" }, kNoTimeout);
      return;
    }
    // The sandbox cannot zip trace entries itself, so it always asks the server
    // for the finished archive and saves it into the sandbox's temp area.
    const result = await this._channel.tracingStopChunk({ mode: "archive" }, kNoTimeout);
    // The artifact may be missing if the browser closed while stopping tracing.
    if (!result.artifact) return;
    const artifact = Artifact.from(result.artifact);
    try {
      await artifact.saveAs(filePath);
    } catch (error) {
      // Delete the artifact best-effort, the save error is the one to surface.
      await artifact.delete().catch(() => {});
      throw error;
    }
    await artifact.delete();
  }

  _resetStackCounter() {
    if (this._isTracing) {
      this._isTracing = false;
      this._connection.setIsTracing(false);
    }
  }
}
