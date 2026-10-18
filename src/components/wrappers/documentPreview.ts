export default function createDocumentPreview(source: string) {
  const image = document.createElement('img');
  image.src = source;
  return image;
}
