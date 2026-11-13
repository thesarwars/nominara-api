// STORY-097 AC4 - the name a report file travels under (the attachment, the export response, the download header). With the
// platform brand removed (the entitlement held NOW and the theme's switch set) no platform name may appear anywhere in a
// file the agency's client receives, the file name included.
export function reportFileName(showBrand: boolean, stamp: string, format: string, suffix = ""): string {
  return `${showBrand ? "nominara-report" : "report"}-${stamp}${suffix}.${format}`;
}
