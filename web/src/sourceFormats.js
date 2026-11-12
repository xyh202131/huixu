const archiveExtensions = ['.tar.gz', '.tar.bz2', '.tar.xz', '.zip', '.7z', '.rar', '.tar', '.tgz', '.tbz2', '.txz', '.gz', '.bz2', '.xz'];
const documentExtensions = ['.pdf', '.docx', '.doc', '.rtf', '.xlsx', '.xls', '.csv', '.tsv', '.pptx', '.ppt',
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif'];

export const sourceAccept = [...documentExtensions, ...archiveExtensions].join(',');
export const isArchiveName = name => archiveExtensions.some(extension => name.toLowerCase().endsWith(extension));
export const isSupportedSource = name => isArchiveName(name) || documentExtensions.some(extension => name.toLowerCase().endsWith(extension));
