/// <reference types="vite/client" />
declare module "*.py?raw" {
  const text: string;
  export default text;
}
