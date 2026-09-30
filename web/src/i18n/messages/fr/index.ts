import type { Dict } from "../en";
import { frApp } from "./app";
import { frEditor } from "./editor";
import { frMail } from "./mail";
import { frSite } from "./site";

export const fr: Dict = { ...frSite, ...frApp, ...frEditor, ...frMail };
