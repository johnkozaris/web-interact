// @ts-nocheck
import { ChannelOwner } from "./channelOwner";
import { deleteTempFile, readTempFile, resolveTempFilePath } from "./fileUtils";

function createArtifactTempName(artifact) {
  const guid =
    typeof artifact?._guid === "string" && artifact._guid.length > 0
      ? artifact._guid
      : `artifact-${Date.now()}`;
  return `.artifacts/${guid}-${Date.now()}.bin`;
}

export class Artifact extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }

  async pathAfterFinished() {
    if (this._connection.isRemote()) {
      throw new Error("Path is not available when connecting remotely. Use saveAs() instead.");
    }
    return (await this._channel.pathAfterFinished()).value;
  }

  async saveAs(path) {
    const resolvedPath = await resolveTempFilePath(path);
    await this._channel.saveAs({ path: resolvedPath });
  }

  async failure() {
    return (await this._channel.failure()).error || null;
  }

  async createReadStream() {
    throw new Error(
      "Artifact streams are not available in the QuickJS sandbox. Use readIntoBuffer() or saveAs()."
    );
  }

  async readIntoBuffer() {
    const tempName = createArtifactTempName(this);
    const resolvedPath = await resolveTempFilePath(tempName);
    await this._channel.saveAs({ path: resolvedPath });
    try {
      return await readTempFile(tempName, { encoding: "base64" });
    } finally {
      await deleteTempFile(tempName).catch(() => undefined);
    }
  }

  async cancel() {
    await this._channel.cancel?.();
  }

  async delete() {
    await this._channel.delete?.();
  }
}
