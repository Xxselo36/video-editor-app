import type { Dict } from "../en";
import { plApp } from "./app";
import { plEditor } from "./editor";
import { plMail } from "./mail";
import { plLanding } from "./landing";
import { plSite } from "./site";

export const pl: Dict = { ...plSite, ...plLanding, ...plApp, ...plEditor, ...plMail };
