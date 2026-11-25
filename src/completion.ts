import { type Node, ROOT } from "./tree";

// Shell completion scripts, generated from the command tree, so every
// generated command and flag completes without a hand-kept list.

const GLOBAL_FLAGS = [
    "--compact",
    "--help",
    "--network",
    "--pretty",
    "--profile",
    "--version",
];

type Level = { candidates: string[]; path: string[]; words: string[] };

const levels = (node: Node, found: Level[] = []): Level[] => {
    const words = [...node.children.keys()];
    const flags = node.command
        ? node.command.inputs
              .filter((input) => input.position === undefined)
              .map((input) => `--${input.flag}`)
        : [];
    found.push({
        candidates: [...words, ...flags, ...GLOBAL_FLAGS],
        path: node.path,
        words,
    });
    for (const child of node.children.values()) {
        levels(child, found);
    }
    return found;
};

const bash = () => {
    const cases = levels(ROOT)
        .map(
            ({ candidates, path }) =>
                `      "${path.join(" ")}") candidates="${candidates.join(" ")}"; break ;;`
        )
        .join("\n");
    return `# gumag completion for bash. Add to ~/.bashrc: source <(gumag completion bash)
_gumag() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" word candidates=""
  for word in "\${COMP_WORDS[@]:1:COMP_CWORD-1}"; do
    case "$word" in -*) break ;; esac
    path="\${path:+$path }$word"
  done
  while :; do
    case "$path" in
${cases}
      *" "*) path="\${path% *}" ;;
      *) path="" ;;
    esac
  done
  COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
}
complete -o default -F _gumag gumag gumx
`;
};

const zsh = () =>
    [
        "# gumag completion for zsh. Add to ~/.zshrc: source <(gumag completion zsh)",
        "autoload -U +X bashcompinit && bashcompinit",
        ...bash().split("\n").slice(1),
    ].join("\n");

const fish = () => {
    const lines = [
        "# gumag completion for fish: gumag completion fish > ~/.config/fish/completions/gumag.fish",
    ];
    for (const { candidates, path, words } of levels(ROOT)) {
        const condition =
            path.length === 0
                ? "__fish_use_subcommand"
                : path
                      .map((word) => `__fish_seen_subcommand_from ${word}`)
                      .join("; and ");
        for (const word of words) {
            lines.push(`complete -c gumag -f -n "${condition}" -a ${word}`);
        }
        for (const flag of candidates.filter(
            (candidate) =>
                candidate.startsWith("--") && !GLOBAL_FLAGS.includes(candidate)
        )) {
            lines.push(
                `complete -c gumag -f -n "${condition}" -l ${flag.slice(2)}`
            );
        }
    }
    for (const flag of GLOBAL_FLAGS) {
        lines.push(`complete -c gumag -f -l ${flag.slice(2)}`);
    }
    lines.push("complete -c gumx -w gumag");
    return `${lines.join("\n")}\n`;
};

export const completionScript = (shell: string) => {
    if (shell === "fish") {
        return fish();
    }
    return shell === "zsh" ? zsh() : bash();
};
