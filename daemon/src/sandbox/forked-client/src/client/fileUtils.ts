// @ts-nocheck
export const fileUploadSizeLimit = 50 * 1024 * 1024;

function getHostFunction(name) {
  const fn = globalThis[name];
  if (typeof fn !== "function") throw new Error(`${name}() is not available in the QuickJS sandbox`);
  return fn;
}

export async function mkdirIfNeeded() {}

export async function writeTempFile(path, data) {
  return await getHostFunction("writeFile")(path, data);
}

export async function readTempFile(path, options = {}) {
  const encoding = options?.encoding === "base64" ? "base64" : "utf8";
  const value = await getHostFunction("readFile")(path, { encoding });
  return encoding === "base64" ? Buffer.from(value, "base64") : value;
}

export async function resolveTempFilePath(path) {
  return await getHostFunction("resolveFilePath")(path);
}

export async function deleteTempFile(path) {
  const deleteFile = globalThis.deleteFile;
  if (typeof deleteFile === "function") {
    await deleteFile(path);
  }
}
