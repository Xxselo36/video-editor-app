import type { Dict } from "../en";
import { frApp } from "./app";
import { frEditor } from "./editor";
import { frMail } from "./mail";
import { frLanding } from "./landing";
import { frSite } from "./site";

export const fr: Dict = { ...frSite, ...frLanding, ...frApp, ...frEditor, ...frMail };
