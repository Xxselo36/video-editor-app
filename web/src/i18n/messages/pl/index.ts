import type { Dict } from "../en";
import { plApp } from "./app";
import { plEditor } from "./editor";
import { plMail } from "./mail";
import { plSite } from "./site";

export const pl: Dict = { ...plSite, ...plApp, ...plEditor, ...plMail };
