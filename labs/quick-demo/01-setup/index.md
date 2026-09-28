# Setup

Node.js, yamlctl, and a data file with its schema.

## Node.js

1. Install Node.js LTS

   <!-- verify: requires=network timeout=300 expect="11." -->

   ```bash exec
   printf 'timeout = 30\ntries = 3\n' > ~/.wgetrc && \
   wget -qO- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash && \
   \. "$HOME/.nvm/nvm.sh" && \
   nvm install $NODE_MAJOR && \
   npm -v
   ```

2. Update PATH

   ```bash exec
   mkdir -p ~/.npm-global && \
   export PATH="$HOME/.npm-global/bin:$PATH" && \
   echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
   ```

## yamlctl

1. Install yamlctl from npmjs.org

   <!-- verify: requires=network timeout=180 expect="added" -->

   ```bash exec
   npm install -g yamlctl &&
   yamlctl --version
   ```

2. *Optional:* Display the version and the usage

   <!-- verify: requires=network expect="Usage:" -->

   ```bash exec
   yamlctl --help
   ```

## Data

1. Copy the data file and its schema

   <!-- verify: expect="project.schema.json" -->

   ```bash exec
   cp -r "$LAB_COURSE_DIR/files/." . && ls -R
   ```

2. Open [project.yaml](:open:project.yaml) and [its schema](:open:schemas/project.schema.json)

   > [!NOTE]
   > The first line of the data file names its schema, the line the YAML language server reads in an editor, so the editor and yamlctl check against the same schema.
