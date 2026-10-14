// Stand-in for the `colors/safe` package in the QuickJS sandbox bundle, using
// the same ANSI styling the sandbox used before Playwright 1.64.
import { webColors } from "../src/utils/isomorphic/colors";

export default webColors;
