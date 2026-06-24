import { runLocalPanopticon } from "./data.js";

export function handleLocal(args: string[]): void {
  runLocalPanopticon(args.length > 0 ? args : ["--help"]);
}
