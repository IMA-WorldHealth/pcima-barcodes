const pptr = require('puppeteer-core');
const fs = require('fs');
const fse = require('fs-extra');
const pdfMerge = require('pdf-merge');
const Progress = require('progress');
const tempy = require('tempy');
const globby = require('globby');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { customAlphabet } = require('nanoid');
const { numbers, uppercase } = require('nanoid-dictionary');

const nanoid = customAlphabet(numbers + uppercase, 12);

// globals
const BATCH_SIZE = 90; // batch size to make
// const TOTAL_NUMBER_OF_TICKETS = 25000;
const TOTAL_NUMBER_OF_TICKETS = 90;

const PAGE_SIZE = 30; // size of a page.
const TEMP_DIR = tempy.directory();

const normalizeCSS = fs.readFileSync('./node_modules/normalize.css/normalize.css', 'utf8');
const paperCSS = fs.readFileSync('./node_modules/paper-css/paper.min.css', 'utf8');
const jsBarcode = fs.readFileSync('./node_modules/jsbarcode/dist/JsBarcode.all.min.js', 'utf8');
const template = fs.readFileSync('template.html', 'utf8');

const LEN = Number(TOTAL_NUMBER_OF_TICKETS).toString().length;

// base64 logos
/*
const imaLogo = fs.readFileSync('./lib/ima-logo.jpg').toString('base64');
const corusLogo = fs.readFileSync('./lib/corus-logo.png').toString('base64');
*/

const sanity = [];

function genId() {
  let id = nanoid();
  while (sanity.includes(id)) {
    id = nanoid();
  }

  sanity.push(id);

  return id;
}

function generateIdentifiers() {
  console.log('generating identifiers');
  let i = TOTAL_NUMBER_OF_TICKETS;
  while (i--) {
    genId();
  }
  console.log(`done generating ${sanity.length} identifiers.  Sorting...`);
  sanity.sort();
  console.log('done sorting identifiers');
}

async function makeItem(ident) {
  // make a data URL out of the QR code.
  // const url = await QR.toDataURL(String(id));

  // const ima = `data:image/jpeg;base64,${imaLogo}`;
  // const corus = `data:image/png;base64,${corusLogo}`;

  return `
    <div class="label">
      <svg 
        class="barcode"
        jsbarcode-format="auto"
        jsbarcode-width="1"
        jsbarcode-height="35"
        jsbarcode-fontsize="8"
        jsbarcode-value="${ident}"
        jsbarcode-textmargin="0">
      </svg>
    </div>
  `;
}

const headless = true;

function extractNumberFromFileName(fname) {
  const last = fname.split('-').pop().replace('.txt', '');
  return parseInt(last, 10);
}

async function createTemplatesFromRange(start, stop, statusbar) {
  console.log('Creating text templates');

  const items = [];
  for (let i = start; i <= stop; i += 1) {
    items.push(makeItem(sanity[i]));

    // after chunk is done, let's write it to disk
    if ((i % PAGE_SIZE) === 0) {
      const chunks = await Promise.all(items);

      // write to temp file
      await fse.writeFile(`${TEMP_DIR}/chunks-temp-${i}.txt`, chunks.join(''), 'utf8');

      // reset the items
      items.length = 0;
    }

    statusbar.tick();
  }
}

function leftPad(num, len) {
  const { length } = Number(num).toString();

  if (length < len) {
    return '0'.repeat(len - length).concat(num);
  }

  return num;
}

async function renderTemplatesFromRange(i, j, statusbar) {
  const files = [];
  const globs = await globby(`${TEMP_DIR}/chunks*.txt`);

  console.log('Sorting templates into sensible ordering');

  // order paths in a sensible order
  globs.sort((a, b) => ((extractNumberFromFileName(a) > extractNumberFromFileName(b)) ? 1 : -1));

  const browser = await pptr.launch({ executablePath: '/usr/bin/chromium-browser', headless });
  let index = 0;
  for (const glob of globs) {
    const sheet = await fse.readFile(glob, 'utf8');

    const content = template
      .replace('INJECT_NORMALIZE', normalizeCSS)
      .replace('INJECT_PAPER_CSS', paperCSS)
      .replace('INJECT_JSBARCODE', jsBarcode)
      .replace('INJECT_CONTENT', `<div class="sheet">${sheet}</div>`);

    const page = await browser.newPage();
    await page.setContent(content);

    await page.addScriptTag({ content: 'JsBarcode(".barcode").init();' });

    const path = `${TEMP_DIR}/tickets-${index++}.pdf`;
    files.push(path);
    await page.pdf({ path, format: 'letter' });

    await page.close();

    statusbar.tick();
  }

  await browser.close();

  console.log('Consolidating all paths into a single path.');
  const fname = `output/${leftPad(i, LEN)}-${leftPad(j, LEN)}-tickets.pdf`;
  await pdfMerge(files, { output: fname });

  console.log(`Zipping PDFs into ${fname}.xz`);
  // await xzPDF(fname);

  // delete all .txt files
  console.log(`Deleting ${globs.length} txt files`);
  await Promise.all(globs.map((path) => fse.unlink(path)));

  // delete all .pdf files
  console.log(`Deleting ${files.length} pdf files`);
  await Promise.all(files.map((path) => fse.unlink(path)));
}

async function makeBatchOfTickets(i, j, statusbar) {
  console.log(`Making a batch of tickets (${i} - ${j})`);
  await createTemplatesFromRange(i, j, statusbar);
  await renderTemplatesFromRange(i, j, statusbar);
}

(async () => {
  console.log('Starting PDF generation...');

  try {
    // generate sanity ids
    generateIdentifiers();

    console.log('Starting creating text templates...');

    const statusbar = new Progress('[:bar] :percent :etas', { total: (TOTAL_NUMBER_OF_TICKETS * 1.9) });

    let i = 1;
    let j = i + BATCH_SIZE;
    while (i <= TOTAL_NUMBER_OF_TICKETS) {
      await makeBatchOfTickets(i, j, statusbar);
      i += BATCH_SIZE;
      j = i + BATCH_SIZE;
    }

    console.log('merging files with pdftk');

    const { stdout, stderr } = await exec('pdftk output/*.pdf cat output tickets.pdf');

    if (stderr) {
      console.error(`error: ${stderr}`);
    }
    console.log(`Number of files ${stdout}`);

    console.log('Writing identifiers out to a CSV file..');
    await fs.promises.writeFile('identifiers.csv', 'uuid\n'.concat(sanity.join('\n')), 'utf8');

    console.log('Done!');
  } catch (e) {
    console.log('e:', e);
  }
})();
