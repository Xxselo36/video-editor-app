import type { Dict } from "../en";
import { deApp } from "./app";
import { deEditor } from "./editor";
import { deMail } from "./mail";
import { deSite } from "./site";

export const de: Dict = { ...deSite, ...deApp, ...deEditor, ...deMail };
