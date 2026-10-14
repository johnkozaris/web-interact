// Stand-in for node:fs in the QuickJS sandbox bundle. Sandboxed code never
// reaches the host filesystem directly; file access goes through the host's
// temp-file callbacks in src/client/fileUtils.ts.

function unavailable(name: string): Error {
  return new Error(`fs.${name}() is not available in the QuickJS sandbox`);
}

// Upstream checks `value instanceof fs.ReadStream`; nothing in the sandbox is one.
export class ReadStream {}
export class WriteStream {}

export function createReadStream(): never {
  throw unavailable("createReadStream");
}

export const promises = {
  readFile: async (): Promise<never> => {
    throw unavailable("promises.readFile");
  },
  writeFile: async (): Promise<never> => {
    throw unavailable("promises.writeFile");
  },
  mkdir: async (): Promise<never> => {
    throw unavailable("promises.mkdir");
  },
  stat: async (): Promise<never> => {
    throw unavailable("promises.stat");
  },
  readdir: async (): Promise<never> => {
    throw unavailable("promises.readdir");
  },
};

export default { ReadStream, WriteStream, createReadStream, promises };
