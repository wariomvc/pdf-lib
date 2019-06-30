import {
  EncryptedPDFError,
  FontkitNotRegisteredError,
  ForeignPageError,
} from 'src/api/errors';
import PDFFont from 'src/api/PDFFont';
import PDFImage from 'src/api/PDFImage';
import PDFPage from 'src/api/PDFPage';
import { PageSizes } from 'src/api/sizes';
import {
  CustomFontEmbedder,
  CustomFontSubsetEmbedder,
  JpegEmbedder,
  PDFCatalog,
  PDFContext,
  PDFObjectCopier,
  PDFPageLeaf,
  PDFPageTree,
  PDFParser,
  PDFStreamWriter,
  PDFWriter,
  PngEmbedder,
  StandardFontEmbedder,
  StandardFonts,
} from 'src/core';
import { Fontkit } from 'src/types/fontkit';
import {
  Cache,
  canBeConvertedToUint8Array,
  isStandardFont,
  toUint8Array,
} from 'src/utils';

class PDFDocument {
  static load = (
    pdf: string | Uint8Array | ArrayBuffer,
    options: { ignoreEncryption?: boolean } = {},
  ) => {
    const { ignoreEncryption = false } = options;
    const bytes = toUint8Array(pdf);
    const context = PDFParser.forBytes(bytes).parseDocument();
    return new PDFDocument(context, ignoreEncryption);
  };

  static create = () => {
    const context = PDFContext.create();
    const pageTree = PDFPageTree.withContext(context);
    const pageTreeRef = context.register(pageTree);
    const catalog = PDFCatalog.withContextAndPages(context, pageTreeRef);
    context.trailerInfo.Root = context.register(catalog);
    return new PDFDocument(context, false);
  };

  readonly context: PDFContext;
  readonly catalog: PDFCatalog;
  readonly isEncrypted: boolean;

  private fontkit?: Fontkit;
  private readonly pageCache: Cache<PDFPage[]>;
  private readonly pageMap: Map<PDFPageLeaf, PDFPage>;
  private readonly fonts: PDFFont[];
  private readonly images: PDFImage[];

  private constructor(context: PDFContext, ignoreEncryption: boolean) {
    this.context = context;
    this.catalog = context.lookup(context.trailerInfo.Root) as PDFCatalog;
    this.isEncrypted = !!context.lookup(context.trailerInfo.Encrypt);

    this.pageCache = Cache.populatedBy(this.computePages);
    this.pageMap = new Map();
    this.fonts = [];
    this.images = [];

    if (!ignoreEncryption && this.isEncrypted) throw new EncryptedPDFError();
  }

  registerFontkit(fontkit: Fontkit): void {
    this.fontkit = fontkit;
  }

  getPages(): PDFPage[] {
    return this.pageCache.access();
  }

  removePage(index: number): void {
    this.catalog.removeLeafNode(index);
  }

  addPage(page?: PDFPage | [number, number]): PDFPage {
    const pages = this.getPages();
    return this.insertPage(pages.length, page);
  }

  insertPage(index: number, page?: PDFPage | [number, number]): PDFPage {
    if (!page || Array.isArray(page)) {
      const dims = Array.isArray(page) ? page : PageSizes.A4;
      page = PDFPage.create(this);
      page.setSize(...dims);
    } else if (page.doc !== this) {
      throw new ForeignPageError();
    }

    const parentRef = this.catalog.insertLeafNode(page.ref, index);
    page.node.setParent(parentRef);

    this.pageMap.set(page.node, page);
    this.pageCache.invalidate();

    return page;
  }

  async copyPages(srcDoc: PDFDocument, pages: number[]): Promise<PDFPage[]> {
    await srcDoc.flush();
    const copier = PDFObjectCopier.for(srcDoc.context, this.context);
    const srcPages = srcDoc.getPages();
    const copiedPages: PDFPage[] = new Array(pages.length);
    for (let idx = 0, len = pages.length; idx < len; idx++) {
      const srcPage = srcPages[pages[idx]];
      const copiedPage = copier.copy(srcPage.node);
      const ref = this.context.register(copiedPage);
      copiedPages[idx] = PDFPage.of(copiedPage, ref, this);
    }
    return copiedPages;
  }

  embedFont(
    font: StandardFonts | string | Uint8Array | ArrayBuffer,
    options: { subset?: boolean } = {},
  ): PDFFont {
    const { subset = false } = options;

    let embedder: CustomFontEmbedder | StandardFontEmbedder;
    if (isStandardFont(font)) {
      embedder = StandardFontEmbedder.for(font);
    } else if (canBeConvertedToUint8Array(font)) {
      const bytes = toUint8Array(font);
      const fontkit = this.assertFontkit();
      embedder = subset
        ? CustomFontSubsetEmbedder.for(fontkit, bytes)
        : CustomFontEmbedder.for(fontkit, bytes);
    } else {
      throw new TypeError(
        '`font` must be one of `StandardFonts | string | Uint8Array | ArrayBuffer`',
      );
    }

    const ref = this.context.nextRef();
    const pdfFont = PDFFont.of(ref, this, embedder);
    this.fonts.push(pdfFont);

    return pdfFont;
  }

  embedJpg(jpg: string | Uint8Array | ArrayBuffer): PDFImage {
    const bytes = toUint8Array(jpg);
    const embedder = JpegEmbedder.for(bytes);
    const ref = this.context.nextRef();
    const pdfImage = PDFImage.of(ref, this, embedder);
    this.images.push(pdfImage);
    return pdfImage;
  }

  embedPng(png: string | Uint8Array | ArrayBuffer): PDFImage {
    const bytes = toUint8Array(png);
    const embedder = PngEmbedder.for(bytes);
    const ref = this.context.nextRef();
    const pdfImage = PDFImage.of(ref, this, embedder);
    this.images.push(pdfImage);
    return pdfImage;
  }

  async flush(): Promise<void> {
    // Embed fonts
    for (let idx = 0, len = this.fonts.length; idx < len; idx++) {
      const font = this.fonts[idx];
      await font.embed();
    }

    // Embed images
    for (let idx = 0, len = this.images.length; idx < len; idx++) {
      const image = this.images[idx];
      await image.embed();
    }
  }

  async save(
    options: { useObjectStreams?: boolean; addDefaultPage?: boolean } = {},
  ): Promise<Uint8Array> {
    const { useObjectStreams = true, addDefaultPage = true } = options;
    if (addDefaultPage && this.getPages().length === 0) this.addPage();
    await this.flush();
    const Writer = useObjectStreams ? PDFStreamWriter : PDFWriter;
    return Writer.forContext(this.context).serializeToBuffer();
  }

  private assertFontkit(): Fontkit {
    if (!this.fontkit) throw new FontkitNotRegisteredError();
    return this.fontkit;
  }

  private computePages = (): PDFPage[] => {
    const pages: PDFPage[] = [];
    this.catalog.Pages().traverse((node, ref) => {
      if (node instanceof PDFPageLeaf) {
        let page = this.pageMap.get(node);
        if (!page) {
          page = PDFPage.of(node, ref, this);
          this.pageMap.set(node, page);
        }
        pages.push(page);
      }
    });
    return pages;
  };
}

export default PDFDocument;
