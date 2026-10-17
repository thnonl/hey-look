// The editor kit chunk (kit.ts): the nodes that are not needed before an editor opens.

import type { AnyExtension } from "@tiptap/react";
import { PictureNode } from "./pictureNode";
import { tableExtensions } from "./tableExtension";

export const kitExtensions = (o: { pictures: boolean }): AnyExtension[] => [...tableExtensions(), ...(o.pictures ? [PictureNode] : [])];
