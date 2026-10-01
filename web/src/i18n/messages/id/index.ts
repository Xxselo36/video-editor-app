import type { Dict } from "../en";
import { idApp } from "./app";
import { idEditor } from "./editor";
import { idMail } from "./mail";
import { idSite } from "./site";

export const id: Dict = { ...idSite, ...idApp, ...idEditor, ...idMail };
