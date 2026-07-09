// Adversarial eval case list (151 cases). Exported as an array of case
// objects. Born from the v6 QA gate -- a one-off pre-release check run
// against the v6 model revision -- and promoted here as a permanent eval
// tier; the case content is unchanged from that run.
//
// category: quantity | regression | spot
// For quantity cases: expect = { lo, hi } total resolved grams (generous band,
// derived from nutrition-knowledge per-unit weights), plus a floor `notUnit`
// used to flag the v5-style "collapsed to 1 unit" catastrophic failure.
//
// See ./run.mjs to execute these against a live OpenAI-compatible endpoint.

export const CASES = [
  // ============ QUANTITY CLUSTER ============
  // -- numeric counts across foods --
  { id: 'q-numeric-tacos10', cat: 'quantity', sub: 'numeric', text: '10 soft tacos', expect: { lo: 800, hi: 1400 } },
  { id: 'q-numeric-eggs4', cat: 'quantity', sub: 'numeric', text: '4 eggs', expect: { lo: 170, hi: 230 } },
  { id: 'q-numeric-wings15', cat: 'quantity', sub: 'numeric', text: '15 wings', expect: { lo: 400, hi: 1400 } },
  { id: 'q-numeric-cookies7', cat: 'quantity', sub: 'numeric', text: '7 cookies', expect: { lo: 90, hi: 280 } },
  { id: 'q-numeric-nuggets20', cat: 'quantity', sub: 'numeric', text: '20 chicken nuggets', expect: { lo: 260, hi: 450 } },
  { id: 'q-numeric-dumplings12', cat: 'quantity', sub: 'numeric', text: '12 dumplings', expect: { lo: 150, hi: 340 } },
  { id: 'q-numeric-tenders6', cat: 'quantity', sub: 'numeric', text: '6 chicken tenders', expect: { lo: 260, hi: 460 } },
  { id: 'q-numeric-shrimptempura9', cat: 'quantity', sub: 'numeric', text: '9 shrimp tempura pieces', expect: { lo: 110, hi: 250 } },
  { id: 'q-numeric-pizzaslices5', cat: 'quantity', sub: 'numeric', text: '5 slices of pepperoni pizza', expect: { lo: 450, hi: 750 } },
  { id: 'q-numeric-minipancakes8', cat: 'quantity', sub: 'numeric', text: '8 mini pancakes', expect: { lo: 100, hi: 220 } },
  { id: 'q-numeric-bacon3', cat: 'quantity', sub: 'numeric', text: '3 slices of bacon', expect: { lo: 20, hi: 36 } },
  { id: 'q-numeric-tots16', cat: 'quantity', sub: 'numeric', text: '16 tater tots', expect: { lo: 200, hi: 360 } },
  { id: 'q-numeric-wings24', cat: 'quantity', sub: 'numeric', text: '24 chicken wings', expect: { lo: 650, hi: 2200 } },

  // -- number-words --
  { id: 'q-words-burgers2', cat: 'quantity', sub: 'number-words', text: 'two burgers', expect: { lo: 350, hi: 550 } },
  { id: 'q-words-pizzaslices3', cat: 'quantity', sub: 'number-words', text: 'three slices of pizza', expect: { lo: 270, hi: 450 } },
  { id: 'q-words-donuts6', cat: 'quantity', sub: 'number-words', text: 'six donuts', expect: { lo: 240, hi: 400 } },
  { id: 'q-words-beers2', cat: 'quantity', sub: 'number-words', text: 'two beers', expect: { lo: 620, hi: 780 } },
  { id: 'q-words-dumplings4', cat: 'quantity', sub: 'number-words', text: 'four dumplings', expect: { lo: 50, hi: 110 } },
  { id: 'q-words-wings5', cat: 'quantity', sub: 'number-words', text: 'five chicken wings', expect: { lo: 120, hi: 480 } },
  { id: 'q-words-hotdogs2', cat: 'quantity', sub: 'number-words', text: 'two hot dogs', expect: { lo: 180, hi: 300 } },
  { id: 'q-words-tacos3', cat: 'quantity', sub: 'number-words', text: 'three tacos', expect: { lo: 240, hi: 420 } },
  { id: 'q-words-cake2', cat: 'quantity', sub: 'number-words', text: 'two slices of cake', expect: { lo: 160, hi: 270 } },
  { id: 'q-words-meatballs8', cat: 'quantity', sub: 'number-words', text: 'eight meatballs', expect: { lo: 130, hi: 270 } },

  // -- dozen / half-dozen --
  { id: 'q-dozen-donuts', cat: 'quantity', sub: 'dozen', text: 'a dozen donuts', expect: { lo: 480, hi: 780 } },
  { id: 'q-dozen-wingshalf', cat: 'quantity', sub: 'dozen', text: 'half a dozen wings', expect: { lo: 150, hi: 600 } },
  { id: 'q-dozen-dumplings', cat: 'quantity', sub: 'dozen', text: 'a dozen dumplings', expect: { lo: 150, hi: 340 } },
  { id: 'q-dozen-oystershalf', cat: 'quantity', sub: 'dozen', text: 'half a dozen oysters', expect: { lo: 70, hi: 180 } },
  { id: 'q-dozen-minimuffins', cat: 'quantity', sub: 'dozen', text: 'a dozen mini muffins', expect: { lo: 260, hi: 460 } },
  { id: 'q-dozen-bagelshalf', cat: 'quantity', sub: 'dozen', text: 'half a dozen bagels', expect: { lo: 450, hi: 700 } },
  { id: 'q-dozen-mozzsticks', cat: 'quantity', sub: 'dozen', text: 'a dozen mozzarella sticks', expect: { lo: 180, hi: 320 } },

  // -- fractions --
  { id: 'q-frac-pizzahalf', cat: 'quantity', sub: 'fraction', text: 'half a pizza', expect: { lo: 300, hi: 550 } },
  { id: 'q-frac-chickenhalf', cat: 'quantity', sub: 'fraction', text: 'half a rotisserie chicken', expect: { lo: 220, hi: 480 } },
  { id: 'q-frac-lasagnaquarter', cat: 'quantity', sub: 'fraction', text: 'a quarter of the lasagna', expect: { lo: 250, hi: 650 } },
  { id: 'q-frac-sandwichhalf', cat: 'quantity', sub: 'fraction', text: 'half a sandwich', expect: { lo: 80, hi: 170 } },
  { id: 'q-frac-cakequarter', cat: 'quantity', sub: 'fraction', text: 'a quarter of a cake', expect: { lo: 180, hi: 330 } },
  { id: 'q-frac-burritohalf', cat: 'quantity', sub: 'fraction', text: 'half a burrito', expect: { lo: 180, hi: 320 } },
  { id: 'q-frac-piethird', cat: 'quantity', sub: 'fraction', text: 'a third of a pie', expect: { lo: 260, hi: 400 } },

  // -- whole / family-size --
  { id: 'q-whole-pizza', cat: 'quantity', sub: 'whole-family', text: 'a whole pizza', expect: { lo: 600, hi: 1300 } },
  { id: 'q-whole-chipsbag', cat: 'quantity', sub: 'whole-family', text: 'the whole bag of chips', expect: { lo: 150, hi: 450 } },
  { id: 'q-whole-chicken', cat: 'quantity', sub: 'whole-family', text: 'a whole rotisserie chicken', expect: { lo: 450, hi: 1000 } },
  { id: 'q-whole-chipsfamily', cat: 'quantity', sub: 'whole-family', text: 'a family size bag of chips', expect: { lo: 200, hi: 500 } },
  { id: 'q-whole-donutbox', cat: 'quantity', sub: 'whole-family', text: 'the whole box of donuts', expect: { lo: 450, hi: 800 } },
  { id: 'q-whole-breadloaf', cat: 'quantity', sub: 'whole-family', text: 'a whole loaf of bread', expect: { lo: 400, hi: 800 } },

  // -- oz / lb --
  { id: 'q-oz-steak8', cat: 'quantity', sub: 'oz-lb', text: '8 oz steak', expect: { lo: 190, hi: 270 } },
  { id: 'q-oz-groundbeeflb', cat: 'quantity', sub: 'oz-lb', text: 'a pound of ground beef', expect: { lo: 400, hi: 500 } },
  { id: 'q-oz-chicken6', cat: 'quantity', sub: 'oz-lb', text: '6 oz of grilled chicken', expect: { lo: 150, hi: 195 } },
  { id: 'q-oz-ribeye12', cat: 'quantity', sub: 'oz-lb', text: '12 oz ribeye', expect: { lo: 300, hi: 380 } },
  { id: 'q-oz-shrimp2lb', cat: 'quantity', sub: 'oz-lb', text: '2 lbs of shrimp', expect: { lo: 820, hi: 980 } },
  { id: 'q-oz-turkeypattyhalflb', cat: 'quantity', sub: 'oz-lb', text: 'a half pound turkey burger patty', expect: { lo: 190, hi: 270 } },

  // -- branded counts --
  { id: 'q-brand-tacobell3', cat: 'quantity', sub: 'branded-count', text: '3 taco bell soft tacos', expect: { lo: 240, hi: 360 } },
  { id: 'q-brand-bigmac2', cat: 'quantity', sub: 'branded-count', text: '2 big macs', expect: { lo: 380, hi: 480 } },
  { id: 'q-brand-mcnuggets5', cat: 'quantity', sub: 'branded-count', text: '5 chicken mcnuggets from mcdonalds', expect: { lo: 60, hi: 110 } },
  { id: 'q-brand-kkdozen', cat: 'quantity', sub: 'branded-count', text: 'a dozen krispy kreme donuts', expect: { lo: 420, hi: 580 } },
  { id: 'q-brand-dominos3', cat: 'quantity', sub: 'branded-count', text: "3 slices of domino's pepperoni pizza", expect: { lo: 270, hi: 420 } },
  { id: 'q-brand-whoppers2', cat: 'quantity', sub: 'branded-count', text: '2 whoppers', expect: { lo: 460, hi: 620 } },
  { id: 'q-brand-oreos4', cat: 'quantity', sub: 'branded-count', text: '4 oreos', expect: { lo: 35, hi: 60 } },

  // ============ REGRESSION SWEEP ============
  // -- breakfasts --
  { id: 'r-bfast-oatmealberries', cat: 'regression', sub: 'breakfast', text: 'oatmeal with mixed berries', expectItems: 2 },
  { id: 'r-bfast-baconeggs', cat: 'regression', sub: 'breakfast', text: 'bacon and eggs', expectItems: 2 },
  { id: 'r-bfast-burrito', cat: 'regression', sub: 'breakfast', text: 'a breakfast burrito', expectItems: null },
  { id: 'r-bfast-yogurtparfait', cat: 'regression', sub: 'breakfast', text: 'a yogurt parfait', expectItems: null },
  { id: 'r-bfast-avotoast', cat: 'regression', sub: 'breakfast', text: 'avocado toast', expectItems: 2 },
  { id: 'r-bfast-bagellox', cat: 'regression', sub: 'breakfast', text: 'a bagel with lox', expectItems: 2 },
  { id: 'r-bfast-wafflesbutter', cat: 'regression', sub: 'breakfast', text: 'waffles with butter', expectItems: 2 },
  { id: 'r-bfast-smoothiebowl', cat: 'regression', sub: 'breakfast', text: 'a smoothie bowl', expectItems: null },

  // -- sandwiches --
  { id: 'r-sand-turkeyclub', cat: 'regression', sub: 'sandwich', text: 'a turkey club sandwich', expectItems: null },
  { id: 'r-sand-blt', cat: 'regression', sub: 'sandwich', text: 'a BLT sandwich', expectItems: null },
  { id: 'r-sand-grilledcheese', cat: 'regression', sub: 'sandwich', text: 'a grilled cheese sandwich', expectItems: null },
  { id: 'r-sand-chickensalad', cat: 'regression', sub: 'sandwich', text: 'a chicken salad sandwich', expectItems: null },
  { id: 'r-sand-tunamelt', cat: 'regression', sub: 'sandwich', text: 'a tuna melt', expectItems: null },
  { id: 'r-sand-phillycheesesteak', cat: 'regression', sub: 'sandwich', text: 'a philly cheesesteak', expectItems: null },
  { id: 'r-sand-italiansub', cat: 'regression', sub: 'sandwich', text: 'an italian sub sandwich', expectItems: null },
  { id: 'r-sand-veggiewrap', cat: 'regression', sub: 'sandwich', text: 'a veggie wrap', expectItems: null },

  // -- salads --
  { id: 'r-salad-cobb', cat: 'regression', sub: 'salad', text: 'a cobb salad', expectItems: null },
  { id: 'r-salad-greek', cat: 'regression', sub: 'salad', text: 'a greek salad', expectItems: null },
  { id: 'r-salad-caesarchicken', cat: 'regression', sub: 'salad', text: 'a caesar salad with grilled chicken', expectItems: null },
  { id: 'r-salad-gardenranch', cat: 'regression', sub: 'salad', text: 'a garden salad with ranch dressing', expectItems: null },
  { id: 'r-salad-nodressing', cat: 'regression', sub: 'salad', text: 'a garden salad, no dressing', expectItems: null, mustNotContain: ['dressing', 'ranch'] },
  { id: 'r-salad-taco', cat: 'regression', sub: 'salad', text: 'a taco salad', expectItems: null },

  // -- bowls --
  { id: 'r-bowl-chipotle', cat: 'regression', sub: 'bowl', text: 'a chipotle chicken burrito bowl with rice, beans, salsa, and cheese', expectItems: 5 },
  { id: 'r-bowl-poke', cat: 'regression', sub: 'bowl', text: 'a poke bowl', expectItems: null },
  { id: 'r-bowl-buddha', cat: 'regression', sub: 'bowl', text: 'a buddha bowl', expectItems: null },
  { id: 'r-bowl-teriyakichicken', cat: 'regression', sub: 'bowl', text: 'a rice bowl with teriyaki chicken', expectItems: null },
  { id: 'r-bowl-acai', cat: 'regression', sub: 'bowl', text: 'an acai bowl', expectItems: null },
  { id: 'r-bowl-noRice', cat: 'regression', sub: 'bowl', text: 'a burrito bowl with just chicken, lettuce and salsa, no rice', expectItems: null, mustNotContain: ['rice'] },

  // -- pasta --
  { id: 'r-pasta-alfredo', cat: 'regression', sub: 'pasta', text: 'a plate of fettuccine alfredo', expectItems: null },
  { id: 'r-pasta-carbonara', cat: 'regression', sub: 'pasta', text: 'spaghetti carbonara', expectItems: null },
  { id: 'r-pasta-macandcheese', cat: 'regression', sub: 'pasta', text: 'a bowl of mac and cheese', expectItems: null },
  { id: 'r-pasta-lasagnaslice', cat: 'regression', sub: 'pasta', text: 'a slice of lasagna', expectItems: null },
  { id: 'r-pasta-pesto', cat: 'regression', sub: 'pasta', text: 'pesto pasta', expectItems: null },

  // -- snacks --
  { id: 'r-snack-trailmix', cat: 'regression', sub: 'snack', text: 'a handful of trail mix', expectItems: null },
  { id: 'r-snack-proteinbar', cat: 'regression', sub: 'snack', text: 'a protein bar', expectItems: 1 },
  { id: 'r-snack-stringcheese', cat: 'regression', sub: 'snack', text: 'a string cheese', expectItems: 1 },
  { id: 'r-snack-applepb', cat: 'regression', sub: 'snack', text: 'an apple with peanut butter', expectItems: 2 },
  { id: 'r-snack-ricecakes', cat: 'regression', sub: 'snack', text: 'two rice cakes', expectItems: 1 },
  { id: 'r-snack-granolabar', cat: 'regression', sub: 'snack', text: 'a granola bar', expectItems: 1 },

  // -- drinks --
  { id: 'r-drink-latte', cat: 'regression', sub: 'drink', text: 'a latte with whole milk', expectItems: null },
  { id: 'r-drink-oj', cat: 'regression', sub: 'drink', text: 'a glass of orange juice', expectItems: 1 },
  { id: 'r-drink-soda', cat: 'regression', sub: 'drink', text: 'a can of soda', expectItems: 1 },
  { id: 'r-drink-icedtea', cat: 'regression', sub: 'drink', text: 'a sweetened iced tea', expectItems: null },
  { id: 'r-drink-smoothie', cat: 'regression', sub: 'drink', text: 'a fruit smoothie', expectItems: null },
  { id: 'r-drink-beer', cat: 'regression', sub: 'drink', text: 'a beer', expectItems: 1 },

  // -- desserts --
  { id: 'r-dessert-brownie', cat: 'regression', sub: 'dessert', text: 'a brownie', expectItems: 1 },
  { id: 'r-dessert-cheesecake', cat: 'regression', sub: 'dessert', text: 'a slice of cheesecake', expectItems: 1 },
  { id: 'r-dessert-sundae', cat: 'regression', sub: 'dessert', text: 'an ice cream sundae', expectItems: null },
  { id: 'r-dessert-applepie', cat: 'regression', sub: 'dessert', text: 'a slice of apple pie', expectItems: null },
  { id: 'r-dessert-choccake', cat: 'regression', sub: 'dessert', text: 'a slice of chocolate cake', expectItems: 1 },
  { id: 'r-dessert-milkshake', cat: 'regression', sub: 'dessert', text: 'a milkshake', expectItems: 1 },

  // -- condiments present (must not drop) --
  { id: 'r-cond-burgerketchupmayo', cat: 'regression', sub: 'cond-present', text: 'a burger with ketchup and mayo', expectItems: null, mustContain: ['ketchup', 'mayo'] },
  { id: 'r-cond-friesranch', cat: 'regression', sub: 'cond-present', text: 'fries with ranch', expectItems: 2, mustContain: ['ranch'] },
  { id: 'r-cond-hotdogmustardrelish', cat: 'regression', sub: 'cond-present', text: 'a hot dog with mustard and relish', expectItems: null, mustContain: ['mustard', 'relish'] },
  { id: 'r-cond-sandwichmayo', cat: 'regression', sub: 'cond-present', text: 'a turkey sandwich with mayo', expectItems: null, mustContain: ['mayo'] },
  { id: 'r-cond-saladdressing', cat: 'regression', sub: 'cond-present', text: 'a salad with ranch dressing', expectItems: null, mustContain: ['ranch', 'dressing'] },

  // -- condiments absent (must not hallucinate) --
  { id: 'r-cond-plainburger', cat: 'regression', sub: 'cond-absent', text: 'a plain hamburger, nothing on it', expectItems: null, mustNotContain: ['ketchup', 'mayo', 'mustard', 'cheese'] },
  { id: 'r-cond-drytoast', cat: 'regression', sub: 'cond-absent', text: 'a slice of dry toast', expectItems: 1, mustNotContain: ['butter', 'jam', 'jelly'] },
  { id: 'r-cond-plaingrilledchicken', cat: 'regression', sub: 'cond-absent', text: 'a plain grilled chicken breast', expectItems: 1, mustNotContain: ['oil', 'butter', 'sauce'] },
  { id: 'r-cond-plainrice', cat: 'regression', sub: 'cond-absent', text: 'a bowl of plain white rice', expectItems: 1, mustNotContain: ['butter', 'oil', 'soy'] },
  { id: 'r-cond-blackcoffee', cat: 'regression', sub: 'cond-absent', text: 'a cup of black coffee', expectItems: 1, mustNotContain: ['cream', 'sugar', 'milk'] },

  // -- branded single items --
  { id: 'r-brand-bigmac', cat: 'regression', sub: 'branded-single', text: 'a big mac', expectItems: 1, expectBranded: true },
  { id: 'r-brand-whopper', cat: 'regression', sub: 'branded-single', text: 'a whopper', expectItems: 1, expectBranded: true },
  { id: 'r-brand-baconator', cat: 'regression', sub: 'branded-single', text: "a baconator from wendy's", expectItems: 1, expectBranded: true },
  { id: 'r-brand-blizzard', cat: 'regression', sub: 'branded-single', text: 'an oreo blizzard from dairy queen', expectItems: 1, expectBranded: true },
  { id: 'r-brand-chickfila', cat: 'regression', sub: 'branded-single', text: 'a chick-fil-a chicken sandwich', expectItems: 1, expectBranded: true },
  { id: 'r-brand-starbuckslatte', cat: 'regression', sub: 'branded-single', text: 'a starbucks venti latte', expectItems: 1, expectBranded: true },

  // -- compound multi-item meals --
  { id: 'r-compound-steakdinner', cat: 'regression', sub: 'compound', text: 'a steak dinner with a baked potato and steamed green beans', expectItems: 3 },
  { id: 'r-compound-fishchips', cat: 'regression', sub: 'compound', text: 'fish and chips', expectItems: 2 },
  { id: 'r-compound-englishbreakfast', cat: 'regression', sub: 'compound', text: 'a full english breakfast: eggs, bacon, sausage, beans, and toast', expectItems: 5 },
  { id: 'r-compound-thanksgiving', cat: 'regression', sub: 'compound', text: 'thanksgiving dinner: turkey, mashed potatoes, gravy, and stuffing', expectItems: 4 },
  { id: 'r-compound-tacoplate', cat: 'regression', sub: 'compound', text: 'two tacos, rice, and beans', expectItems: 3 },

  // -- clarification: bare/vague (should ask) --
  { id: 'r-clar-soda', cat: 'regression', sub: 'clar-bare', text: 'a soda', expectAsk: true },
  { id: 'r-clar-burger', cat: 'regression', sub: 'clar-bare', text: 'a burger', expectAsk: true },
  { id: 'r-clar-salad', cat: 'regression', sub: 'clar-bare', text: 'a salad', expectAsk: true },
  { id: 'r-clar-sandwich', cat: 'regression', sub: 'clar-bare', text: 'a sandwich', expectAsk: true },

  // -- clarification: explicit (should NOT ask) --
  { id: 'r-clar-cokecan', cat: 'regression', sub: 'clar-explicit', text: 'a can of coke', expectAsk: false },
  { id: 'r-clar-mcds-cheeseburger', cat: 'regression', sub: 'clar-explicit', text: "a mcdonald's cheeseburger", expectAsk: false },
  { id: 'r-clar-caesarchicken', cat: 'regression', sub: 'clar-explicit', text: 'a caesar salad with grilled chicken', expectAsk: false },
  { id: 'r-clar-ribeye8oz', cat: 'regression', sub: 'clar-explicit', text: 'an 8oz ribeye steak, grilled', expectAsk: false },

  // ============ SPOT ============
  { id: 's-global-padthai', cat: 'spot', sub: 'global', text: 'a plate of pad thai', expectItems: null },
  { id: 's-global-pho', cat: 'spot', sub: 'global', text: 'a bowl of beef pho', expectItems: null },
  { id: 's-global-biryani', cat: 'spot', sub: 'global', text: 'a plate of chicken biryani', expectItems: null },
  { id: 's-global-sushi8', cat: 'spot', sub: 'global', text: '8 pieces of salmon sushi', expect: { lo: 160, hi: 320 } },
  { id: 's-global-shawarma', cat: 'spot', sub: 'global', text: 'a chicken shawarma plate', expectItems: null },
  { id: 's-typo-chicken', cat: 'spot', sub: 'typo', text: 'chiken sanwich', expectItems: null },
  { id: 's-typo-burrito', cat: 'spot', sub: 'typo', text: 'buritto with rice adn beans', expectItems: null },
  { id: 's-typo-pizzaqty', cat: 'spot', sub: 'typo', text: '2 slces of pizza', expect: { lo: 180, hi: 320 } },
  { id: 's-colloq-bigbowlpasta', cat: 'spot', sub: 'colloquial', text: 'a big bowl of pasta', expectItems: null },
  { id: 's-colloq-handfulalmonds', cat: 'spot', sub: 'colloquial', text: 'a small handful of almonds', expectItems: 1 },
  { id: 's-colloq-coupleofcookies', cat: 'spot', sub: 'colloquial', text: 'a couple of cookies', expectItems: 1 },
  { id: 's-colloq-hugeburger', cat: 'spot', sub: 'colloquial', text: 'a huge burger', expectItems: null },
  { id: 's-nonfood-dog', cat: 'spot', sub: 'nonfood', text: 'my dog', expectNonFood: true },
  { id: 's-nonfood-gibberish', cat: 'spot', sub: 'nonfood', text: 'asdfghjkl', expectNonFood: true },
  { id: 's-nonfood-walk', cat: 'spot', sub: 'nonfood', text: 'a walk in the park', expectNonFood: true },
];
