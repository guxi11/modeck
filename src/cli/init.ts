import { migrateHome } from "./scan.js";
import type { HomeMigrationOptions } from "./scan.js";

export { selections } from "./selection.js";
export type { Choice } from "./selection.js";

export const initialize = (root: string, home: string, options: HomeMigrationOptions): Promise<unknown> =>
  migrateHome(root, home, options, true);
