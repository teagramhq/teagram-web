export default async function getFilesFromEvent(e: ClipboardEvent | DragEvent, onlyTypes = false): Promise<any[]> {
  const files: any[] = [];

  const scanFiles = async(entry: any, item: DataTransferItem) => {
    if(entry.isDirectory) {
      const directoryReader = entry.createReader();
      await new Promise<void>((resolve, reject) => {
        directoryReader.readEntries(async(entries: any) => {
          for(const entry of entries) {
            await scanFiles(entry, item);
          }

          resolve();
        });
      });
    } else if(entry) {
      if(onlyTypes) {
        files.push(entry.type);
      } else {
        const itemFile = item.getAsFile(); // * Safari can't handle entry.file with pasting
        const file = entry instanceof File ?
          entry :
          (
            entry instanceof DataTransferItem ?
              entry.getAsFile() :
              await new Promise((resolve, reject) => entry.file(resolve, (err: any) => resolve(itemFile)))
          );

        /* if(!onlyTypes) {
          console.log('getFilesFromEvent: got file', item, file);
        } */

        if(!file) return;
        files.push(file);
      }
    }
  };

  if(e instanceof DragEvent && e.dataTransfer.files && !e.dataTransfer.items) {
    for(let i = 0; i < e.dataTransfer.files.length; i++) {
      const file = e.dataTransfer.files[i];
      files.push(onlyTypes ? file.type : file);
    }
  } else {
    // @ts-ignore
    const items = (e.dataTransfer || e.clipboardData || e.originalEvent.clipboardData).items;

    const promises: Promise<any>[] = [];
    for(let i = 0; i < items.length; ++i) {
      const item: DataTransferItem = items[i];
      if(item.kind === 'file') {
        const entry = (onlyTypes ? item : item.webkitGetAsEntry()) || item.getAsFile();
        promises.push(scanFiles(entry, item));
      }
    }

    await Promise.all(promises);
  }

  /* if(!onlyTypes) {
    console.log('getFilesFromEvent: got files:', e, files);
  } */

  return files;
}

export function loadAlongsideFilesFromEvent<T>(
  e: ClipboardEvent | DragEvent,
  load: () => Promise<T>,
  options: {
    onlyTypes?: boolean,
    files?: any[],
    beforeLoad?: (isFiles: boolean) => void
  } = {}
): {isFiles: boolean, loaded: Promise<T>, files: Promise<any[]>} {
  const dataTransfer = 'dataTransfer' in e ? (e as DragEvent).dataTransfer : undefined;
  const types = dataTransfer?.types;
  // @ts-ignore
  const isFiles = !!(types && (types.contains ? types.contains('Files') : types.indexOf('Files') >= 0));
  const files = options.files ? Promise.resolve(options.files) : getFilesFromEvent(e, options.onlyTypes);

  options.beforeLoad?.(isFiles);
  const loaded = load();

  return {isFiles, loaded, files};
}
