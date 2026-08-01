function classify(content, filename = '') {
  const text = (filename + ' ' + content.substring(0, 1000)).toLowerCase();
  
  if (text.includes('pitch') || text.includes('deck') || text.includes('investor presentation')) {
    return 'pitch_deck';
  }
  
  if (text.includes('balance sheet') || text.includes('income statement') || text.includes('cash flow') || text.includes('profit and loss') || text.includes('p&l')) {
    return 'financial_statements';
  }
  
  if (text.includes('cap table') || text.includes('capitalization') || text.includes('shareholder') || text.includes('equity holding')) {
    return 'cap_table';
  }
  
  if (text.includes('projection') || text.includes('forecast') || text.includes('budget') || text.includes('projected')) {
    return 'projections';
  }

  if (text.includes('mis') || text.includes('management information') || text.includes('dashboard') || text.includes('kpi')) {
    return 'mis';
  }

  return 'unknown';
}

module.exports = { classify };
