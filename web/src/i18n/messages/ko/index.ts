import type { Dict } from "../en";
import { koApp } from "./app";
import { koEditor } from "./editor";
import { koMail } from "./mail";
import { koSite } from "./site";

export const ko: Dict = { ...koSite, ...koApp, ...koEditor, ...koMail };
