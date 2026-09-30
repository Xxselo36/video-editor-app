import type { Dict } from "../en";
import { trApp } from "./app";
import { trEditor } from "./editor";
import { trMail } from "./mail";
import { trSite } from "./site";

export const tr: Dict = { ...trSite, ...trApp, ...trEditor, ...trMail };
