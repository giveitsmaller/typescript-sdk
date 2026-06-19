const pathUploadsAreNodeOnly = () => {
    throw new Error('Path-string file uploads require Node.js (node:fs). In a browser, pass a ' +
        'Blob/File to uploadFile()/file() instead.');
};
export const open = pathUploadsAreNodeOnly;
export const stat = pathUploadsAreNodeOnly;
export const basename = pathUploadsAreNodeOnly;
