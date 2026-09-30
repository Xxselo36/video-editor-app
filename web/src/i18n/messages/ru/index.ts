import type { Dict } from "../en";
import { ruApp } from "./app";
import { ruEditor } from "./editor";
import { ruMail } from "./mail";
import { ruSite } from "./site";

export const ru: Dict = { ...ruSite, ...ruApp, ...ruEditor, ...ruMail };
