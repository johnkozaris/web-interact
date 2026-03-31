// @ts-nocheck
import { Artifact } from "./artifact";
import { ChannelOwner } from "./channelOwner";

export class Tracing extends ChannelOwner {
  _tracesDir;
  _isTracing = false;

  static from(channel) {
    return channel?._object;
  }

  async start(options = {}) {
    await this._wrapApiCall(async () => {
      await this._channel.tracingStart({
        name: options.name,
        snapshots: options.snapshots,
        screenshots: options.screenshots,
        live: options._live,
      });
      await this._channel.tracingStartChunk({
        name: options.name,
        title: options.title,
      });
      this._isTracing = true;
    });
  }

  async startChunk(options = {}) {
    await this._wrapApiCall(async () => {
      await this._channel.tracingStartChunk(options);
      this._isTracing = true;
    });
  }

  async stop(options = {}) {
    await this._wrapApiCall(async () => {
      await this._doStopChunk(options.path);
      await this._channel.tracingStop();
      this._resetStackCounter();
    });
  }

  async stopChunk(options = {}) {
    await this._wrapApiCall(async () => {
      await this._doStopChunk(options.path);
    });
  }

  async group(name, options = {}) {
    await this._channel.tracingGroup({ name, location: options.location });
  }

  async groupEnd() {
    await this._channel.tracingGroupEnd();
  }

  async _doStopChunk(filePath) {
    if (!filePath) {
      await this._channel.tracingStopChunk({ mode: "discard" });
      this._resetStackCounter();
      return;
    }

    const result = await this._channel.tracingStopChunk({ mode: "archive" });
    if (result.artifact) {
      const artifact = Artifact.from(result.artifact);
      await artifact.saveAs(filePath);
      await artifact.delete();
    }
    this._resetStackCounter();
  }

  _resetStackCounter() {
    this._isTracing = false;
  }
}
