import type { Dict } from "../en";
import { jaApp } from "./app";
import { jaEditor } from "./editor";
import { jaMail } from "./mail";
import { jaLanding } from "./landing";
import { jaSite } from "./site";

export const ja: Dict = { ...jaSite, ...jaLanding, ...jaApp, ...jaEditor, ...jaMail };
