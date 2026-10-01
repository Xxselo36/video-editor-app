import type { Dict } from "../en";
import { nlApp } from "./app";
import { nlEditor } from "./editor";
import { nlMail } from "./mail";
import { nlSite } from "./site";

export const nl: Dict = { ...nlSite, ...nlApp, ...nlEditor, ...nlMail };
