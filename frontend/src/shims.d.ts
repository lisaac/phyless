declare const __BUILD_TIME__: string;
declare const __GIT_HASH__: string;

declare module "composerize" {
  // ponytail: composerize ships no types; signature is (cmd: string) => yaml string
  export default function composerize(dockerRunCommand: string): string;
}
declare module "decomposerize" {
  export default function decomposerize(composeYaml: string): string;
}
