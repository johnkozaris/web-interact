// Stand-in for node:stream in the QuickJS sandbox bundle.

export class Readable {}
export class Writable {}

export const promises = {
  pipeline: async (): Promise<never> => {
    throw new Error("Streams are not available in the QuickJS sandbox");
  },
};

export default { Readable, Writable, promises };
