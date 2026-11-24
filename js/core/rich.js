// The 100 richest people in the world: Forbes Real-Time Billionaires, read on November 24, 2026 at 01:25 UTC
// (https://www.forbes.com/real-time-billionaires/). Net worth in US dollars. Used for the money cap (all of them
// together are its first level) and the Billionaire ladder in Trophies. A snapshot: the app does not
// update it, and shows its date next to it.

export const SOURCE = "Forbes Real-Time Billionaires";
export const AS_OF = 1795483503105; // 2026-11-24T01:25:03.105000+00:00
export const RICHEST = [[1, "Elon Musk", 855803754000], [2, "Jeff Bezos", 374416564000], [3, "Larry Page", 234128459000], [4, "Sergey Brin", 215553753000], [5, "Mark Zuckerberg", 205496860000], [6, "Michael Dell", 200068816000], [7, "Warren Buffett", 157349208000], [8, "Steve Ballmer", 154257261000], [9, "Larry Ellison", 152303566000], [10, "Rob Walton & family", 151856638000], [11, "Jim Walton & family", 148620386000], [12, "Amancio Ortega", 148249041000], [13, "Jensen Huang", 143771980000], [14, "Alice Walton", 137968242000], [15, "Carlos Slim Helu & family", 123053256000], [16, "Bill Gates", 119305097000], [17, "Bernard Arnault & family", 115889824000], [18, "Changpeng Zhao", 114611309000], [19, "Francoise Bettencourt Meyers & family", 101486956000], [20, "Michael Bloomberg", 94920000000], [21, "Mukesh Ambani", 94505037000], [22, "Thomas Peterffy", 89489489000], [23, "Giancarlo Devasini", 89300000000], [24, "Gautam Adani", 84820757000], [25, "Julia Koch & family", 84627000000], [26, "Zhang Yiming", 84000000000], [27, "Jeff Yass", 77790000000], [28, "Charles Koch & family", 76942000000], [29, "Tadashi Yanai & family", 71025853000], [30, "Zhong Shanshan", 65296769000], [31, "Dieter Schwarz", 60241641000], [32, "Liang Wenfeng", 59291659000], [33, "Germán Larrea Mota Velasco & family", 56077170000], [34, "Ken Griffin", 54872764000], [35, "Aliko Dangote", 54009842000], [36, "Lukas Walton", 50795284000], [37, "Jacqueline Mars", 50348000000], [37, "John Mars", 50348000000], [39, "Li Ka-shing", 47866130000], [40, "Eric Schmidt", 47427159000], [41, "Giovanni Ferrero", 45352004000], [42, "Gianluigi Aponte", 43478095000], [42, "Rafaela Aponte-Diamant", 43478095000], [44, "Mark Mateschitz", 42593081000], [45, "Masayoshi Son", 41978669000], [46, "Abigail Johnson", 41635256000], [47, "Stephen Schwarzman", 41479317000], [48, "Savitri Jindal & family", 41195295000], [49, "He Xiangjian & family", 40143704000], [50, "Andrea Pignataro", 39651291000], [51, "Alain Wertheimer", 39388149000], [51, "Gerard Wertheimer", 39388149000], [53, "Thomas Frist Jr & family", 38885102000], [54, "Ma Huateng", 38715546000], [55, "Robin Zeng", 38312798000], [56, "Jean-Louis van der Velde", 38000000000], [56, "Paolo Ardoino", 38000000000], [58, "Iris Fontbona & family", 37849042000], [59, "Pham Nhat Vuong", 37758696000], [60, "Alexey Mordashov & family", 36907386000], [61, "Marilyn Simons & family", 36573100000], [62, "Andreas von Bechtolsheim & family", 36066686000], [63, "William Ding", 35621320000], [64, "Len Blavatnik", 34940647000], [65, "Melinda French Gates", 34261425000], [66, "Idan Ofer", 34089027000], [67, "Eduardo Saverin", 33277146000], [68, "Peter Thiel", 32857849000], [69, "Eyal Ofer", 32762172000], [70, "Elaine Marshall & family", 32239000000], [71, "Miriam Adelson & family", 31470660000], [72, "Shiv Nadar", 30864446000], [73, "Colin Huang", 30711273000], [74, "Cyrus Poonawalla", 30560109000], [75, "Henry Samueli", 30118609000], [76, "Vladimir Potanin", 29740299000], [77, "Robert Pera", 29624850000], [78, "Vagit Alekperov", 29475064000], [79, "Lakshmi Mittal", 29115902000], [80, "David Tepper", 28504000000], [81, "Leonid Mikhelson & family", 28301370000], [82, "Lyndal Stephens Greth & family", 28078908000], [83, "Vinod Adani", 28073517000], [84, "MacKenzie Scott", 27699410000], [85, "Stanley Kroenke", 27588800000], [86, "Israel Englander", 27555932000], [87, "Dilip Shanghvi", 27003781000], [88, "Reinhold Wuerth & family", 26811597000], [89, "Steve Cohen", 26667350000], [90, "Jay Y. Lee", 25671876000], [91, "Suleiman Kerimov & family", 25662204000], [92, "Vladimir Lisin", 25532466000], [93, "Greg Brockman", 25486000000], [94, "Rupert Murdoch & family", 25274839000], [95, "Christy Walton", 25132579000], [96, "Emmanuel Besnier", 25059880000], [97, "Stuart Hoegner", 24700000000], [98, "Chen Tianshi", 24572668000], [99, "Phil Knight & family", 24401947000], [100, "Gennady Timchenko", 24165649000]];
/** The combined fortune of the 100 ($7.2687T): the first level of the money cap. */
export const WORLD_CAP = RICHEST.reduce((a, r) => a + r[2], 0);


// Countries: GDP (current US$) of 2025, World Bank indicator NY.GDP.MKTP.CD, data updated November 11, 2026
// (https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD). The 60 largest with a 2025 figure: the World
// Bank has no Taiwan, and no 2025 figure yet for a few (the United Arab Emirates, for one).
export const GDP_SOURCE = "World Bank";
export const GDP_YEAR = 2025;
export const COUNTRIES = [[1, "United States", 30769700000000], [2, "China", 19498039388043], [3, "Germany", 5050922925047], [4, "Japan", 4435162999977], [5, "United Kingdom", 4002587541846], [6, "India", 3956067115772], [7, "France", 3366315927447], [8, "Russia", 2561310169359], [9, "Italy", 2551556954100], [10, "Canada", 2319899772426], [11, "Brazil", 2279920092492], [12, "Spain", 1906453309986], [13, "South Korea", 1872374961553], [14, "Mexico", 1832641364776], [15, "Australia", 1798518933689], [16, "Türkiye", 1597293229287], [17, "Indonesia", 1445642584164], [18, "Netherlands", 1332767651100], [19, "Saudi Arabia", 1276942933333], [20, "Switzerland", 1043529899251], [21, "Poland", 1035491784197], [22, "Belgium", 725466462860], [23, "Ireland", 721701359046], [24, "Argentina", 683097891619], [25, "Sweden", 668998664082], [26, "Israel", 610777842874], [27, "Singapore", 603869516999], [28, "Austria", 579470021095], [29, "Thailand", 577009981112], [30, "Norway", 530755719439], [31, "Vietnam", 514697215165], [32, "Philippines", 487086123720], [33, "Malaysia", 472193128645], [34, "Denmark", 462526660468], [35, "Colombia", 457410034203], [36, "Bangladesh", 456319229256], [37, "Romania", 428677977855], [38, "Hong Kong", 427310315922], [39, "South Africa", 427184325997], [40, "Pakistan", 407307214476], [41, "Czechia", 391026962800], [42, "Egypt", 365254630180], [43, "Iran", 362682115433], [44, "Chile", 357371159575], [45, "Portugal", 346639825142], [46, "Peru", 334854659182], [47, "Finland", 317039368820], [48, "Kazakhstan", 306239209650], [49, "Nigeria", 290794361542], [50, "Algeria", 287031225988], [51, "Greece", 280635521324], [52, "New Zealand", 264057413740], [53, "Iraq", 254367293538], [54, "Hungary", 246490213513], [55, "Qatar", 215559615385], [56, "Ukraine", 214233312784], [57, "Morocco", 182374250612], [58, "Kuwait", 157209026926], [59, "Slovakia", 154530066507], [60, "Uzbekistan", 147038081129]];

// World: UBS Global Wealth Report 2026 (published June 30, 2026), year-end 2025, page 23: the wealth of the four bands
// of its pyramid (over $1M, $100K to $1M, $10K to $100K, under $10K). UBS calls it global wealth: 56 markets that it
// estimates hold over 92% of the world's wealth.
export const WEALTH_SOURCE = "UBS Global Wealth Report 2026";
export const WEALTH_YEAR = 2025;
export const WEALTH_BANDS = [250.59e12, 200.72e12, 63.16e12, 3.22e12];
export const WORLD_WEALTH = Math.round(WEALTH_BANDS.reduce((a, b) => a + b, 0));

/** The money cap by levels. Reaching one unlocks the next; the last one is final (Prestige). */
export const LEVELS = [
  { id: "billionaires", name: "Billionaires", icon: "💎", cap: WORLD_CAP, what: "the combined fortune of the world's 100 richest people" },
  { id: "countries", name: "Countries", icon: "🏛️", cap: COUNTRIES[0][2], what: "a year of the United States' economy" },
  { id: "world", name: "World", icon: "🌍", cap: WORLD_WEALTH, what: "the wealth of the whole world" },
];
export const LAST = LEVELS.length - 1;
export const PRESTIGE_START = 10000;
export const levelOf = s => Math.min(LAST, Math.max(0, s?.level || 0));
export const capOf = s => LEVELS[levelOf(s)].cap;
/** When a portfolio worth `total` reached the cap it's standing on (null when it isn't on one). */
export function reachedAt(s, total) {
  const i = LEVELS.findIndex(l => Math.abs(total - l.cap) < 0.01);
  return i >= 0 ? s.reached?.[i] ?? null : null;
}

/** Where a fortune of `usd` would rank in a list: {place, above: [rank, name, worth] or null, below}. */
export function ladder(usd, list = RICHEST) {
  let i = list.findIndex(r => usd > r[2]);
  if (i < 0) i = list.length;
  return { place: i + 1, above: list[i - 1] || null, below: list[i] || null };
}
