import type { Dict } from "../en";
import { hiApp } from "./app";
import { hiEditor } from "./editor";
import { hiMail } from "./mail";
import { hiSite } from "./site";

export const hi: Dict = { ...hiSite, ...hiApp, ...hiEditor, ...hiMail };
