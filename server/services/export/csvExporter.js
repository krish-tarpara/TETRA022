const { stringify } = require('csv-stringify');

function generateCsv(session, discrepancies, metrics, res) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=FinVerify_Metrics_${session.id}.csv`);

  // Ensure discrepancies is an array
  const findings = discrepancies || [];
  
  // Format the discrepancy data for CSV export
  const exportData = findings.map(d => ({
    ref_code: d.ref_code,
    metric_name: d.metric_name,
    classification: d.classification,
    variance_pct: d.variance_pct ? `${d.variance_pct.toFixed(2)}%` : 'N/A',
    source_a_file: d.source_a?.filename || 'Unknown',
    source_a_context: d.source_a?.context || 'N/A',
    source_b_file: d.source_b?.filename || 'Unknown',
    source_b_context: d.source_b?.context || 'N/A',
    follow_up_question: d.follow_up_question || 'N/A',
    description: d.description || 'N/A'
  }));

  const columns = {
    ref_code: 'Ref Code',
    metric_name: 'Metric',
    classification: 'Classification',
    variance_pct: 'Variance %',
    source_a_file: 'Source A File',
    source_a_context: 'Source A Context',
    source_b_file: 'Source B File',
    source_b_context: 'Source B Context',
    follow_up_question: 'Follow-up Question',
    description: 'Description'
  };

  stringify(exportData, { header: true, columns: columns }, function (err, output) {
    if (err) {
      console.error('Error stringifying CSV:', err);
      res.status(500).send('Error generating CSV');
      return;
    }
    res.send(output);
  });
}

module.exports = { generateCsv };
