import type { Dict } from "../en";
import { esApp } from "./app";
import { esEditor } from "./editor";
import { esMail } from "./mail";
import { esSite } from "./site";

export const es: Dict = { ...esSite, ...esApp, ...esEditor, ...esMail };
