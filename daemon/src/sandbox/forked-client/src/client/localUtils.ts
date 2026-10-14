// @ts-nocheck
import { ChannelOwner } from "./channelOwner";

function unsupported() {
  throw new Error("LocalUtils is not available in the QuickJS sandbox");
}

export class LocalUtils extends ChannelOwner {
  static from(channel) {
    return channel?._object;
  }

  constructor(parent, type, guid, initializer) {
    super(parent, type, guid, initializer);
    // Device descriptors are plain data from the host, so the sandbox can use
    // playwright.devices the same way regular Playwright does.
    this.devices = {};
    for (const { name, descriptor } of initializer?.deviceDescriptors ?? [])
      this.devices[name] = descriptor;
  }

  async connect() {
    unsupported();
  }

  // Trace stacks are collected on the host filesystem, which the sandbox
  // cannot reach. Traces saved from the sandbox therefore carry no source
  // stacks, but tracing itself keeps working.
  async tracingStarted() {
    return {};
  }

  async traceDiscarded() {}

  async addStackToTracingNoReply() {}

  async zip() {
    unsupported();
  }

  async harOpen() {
    unsupported();
  }

  async harLookup() {
    unsupported();
  }

  async harClose() {
    unsupported();
  }

  async harUnzip() {
    unsupported();
  }
}
