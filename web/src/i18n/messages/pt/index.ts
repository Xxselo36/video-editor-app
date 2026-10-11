import type { Dict } from "../en";
import { ptApp } from "./app";
import { ptEditor } from "./editor";
import { ptMail } from "./mail";
import { ptLanding } from "./landing";
import { ptSite } from "./site";

export const pt: Dict = { ...ptSite, ...ptLanding, ...ptApp, ...ptEditor, ...ptMail };
