// Stand-in for node:util in the QuickJS sandbox bundle.

export const inspect = Object.assign((value: unknown): string => String(value), {
  custom: Symbol.for("nodejs.util.inspect.custom"),
});

export default { inspect };
