import type { Dict } from "../en";
import { itApp } from "./app";
import { itEditor } from "./editor";
import { itMail } from "./mail";
import { itSite } from "./site";

export const it: Dict = { ...itSite, ...itApp, ...itEditor, ...itMail };
