// The editor kit chunk (kit.ts): the nodes that are not needed before an editor opens.

import type { AnyExtension } from "@tiptap/react";
import { FindReplace } from "./findReplace";
import { PictureNode } from "./pictureNode";
import { QuoteBlock, type QuoteOptions } from "./quoteNode";
import { tableExtensions } from "./tableExtension";

export const kitExtensions = (o: { pictures: boolean; quote?: QuoteOptions; find?: boolean }): AnyExtension[] => [
  ...tableExtensions(),
  ...(o.find ? [FindReplace] : []),
  ...(o.pictures ? [PictureNode] : []),
  ...(o.quote ? [QuoteBlock.configure(o.quote)] : []),
];
