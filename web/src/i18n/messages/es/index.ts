import type { Dict } from "../en";
import { esApp } from "./app";
import { esEditor } from "./editor";
import { esMail } from "./mail";
import { esLanding } from "./landing";
import { esSite } from "./site";

export const es: Dict = { ...esSite, ...esLanding, ...esApp, ...esEditor, ...esMail };
