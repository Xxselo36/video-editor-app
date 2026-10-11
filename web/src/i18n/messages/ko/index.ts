import type { Dict } from "../en";
import { koApp } from "./app";
import { koEditor } from "./editor";
import { koMail } from "./mail";
import { koLanding } from "./landing";
import { koSite } from "./site";

export const ko: Dict = { ...koSite, ...koLanding, ...koApp, ...koEditor, ...koMail };
