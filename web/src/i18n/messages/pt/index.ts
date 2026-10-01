import type { Dict } from "../en";
import { ptApp } from "./app";
import { ptEditor } from "./editor";
import { ptMail } from "./mail";
import { ptSite } from "./site";

export const pt: Dict = { ...ptSite, ...ptApp, ...ptEditor, ...ptMail };
