import type { Dict } from "../en";
import { trApp } from "./app";
import { trEditor } from "./editor";
import { trMail } from "./mail";
import { trLanding } from "./landing";
import { trSite } from "./site";

export const tr: Dict = { ...trSite, ...trLanding, ...trApp, ...trEditor, ...trMail };
