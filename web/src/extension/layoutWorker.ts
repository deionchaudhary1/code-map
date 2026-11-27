/// <reference types="vite/client" />

import ELK from "elkjs/lib/elk-api";
import LayoutWorker from "elkjs/lib/elk-worker.min.js?worker&inline";

export default class WebviewELK extends ELK {
  // The shared loader accepts CJS modules via their `.default` property.
  // Override ELK's inherited self-export so it instantiates this worker wrapper.
  static default = WebviewELK;

  constructor() {
    super({ workerFactory: () => new LayoutWorker() });
  }
}
