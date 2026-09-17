{
  description = "Quizz Canapé — quiz familial multijoueur local (vanilla JS + Vite)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));

      # Source de build nettoyée : on inclut UNIQUEMENT ce dont Vite a besoin.
      # `.env` (secret), `node_modules`, `dist`, `.git`, `SPEC.md`, etc. sont exclus.
      buildSource = pkgs: pkgs.lib.fileset.toSource {
        root = ./.;
        fileset = pkgs.lib.fileset.unions [
          ./index.html
          ./package.json
          ./package-lock.json
          ./vite.config.js
          ./public
          ./src
        ];
      };
    in
    {
      # --- Build : site statique compilé (dist/) -------------------------------
      packages = forAllSystems (pkgs: {
        default = pkgs.buildNpmPackage {
          pname = "quizz-canape";
          version = "1.0.0";
          src = buildSource pkgs;
          nodejs = pkgs.nodejs_24;
          npmDepsHash = "sha256-1YujJb7F4Udrq9iZPM/tRRuO/4AfKmcpzHO2+oX4VqA=";
          # `vite build` n'exige pas de `.env` (le proxy n'existe qu'en dev).
          buildPhase = "npm run build";
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r dist/. "$out/"
            runHook postInstall
          '';
        };
      });

      # --- Environnement de développement (nodejs + npm) -----------------------
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # NB : le CLI Vercel n'est plus dans nixpkgs (nodePackages retiré,
          # pas de paquet top-level `vercel`) → on le passe par `npx` (npm).
          packages = [
            pkgs.nodejs_24
          ];
          shellHook = ''
            echo ""
            echo "  Quizz Canapé — env de dev (node $(node --version))"
            echo "  ------------------------------------------------"
            echo "    npm install           # installe vite (node_modules)"
            echo "    cp .env.example .env  # puis renseigner LLM_API_KEY"
            echo "    npm run dev           # http://localhost:5173"
            echo "    npm run dev-ws        # multijoueur : relais WS + Vite"
            echo "    npm run build         # génère dist/ (nix build .# en fait autant)"
            echo ""
            echo "  Vercel CLI (via npx — nixpkgs ne l'embarque plus) :"
            echo "    npx vercel login      # authentification"
            echo "    npx vercel link       # lier le projet"
            echo ""
          '';
        };
      });

      # --- Vérif. basique : le build doit réussir sans secret ------------------
      checks = forAllSystems (pkgs: {
        build = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });
    };
}
