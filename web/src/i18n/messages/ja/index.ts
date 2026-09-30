import type { Dict } from "../en";
import { jaApp } from "./app";
import { jaEditor } from "./editor";
import { jaMail } from "./mail";
import { jaSite } from "./site";

export const ja: Dict = { ...jaSite, ...jaApp, ...jaEditor, ...jaMail };
