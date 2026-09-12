import { getSupabaseAdmin } from '../lib/supabase-server';
import type { Layer } from '../types';

const pageId = 'e9c9a71d-ff08-4eb5-84af-94bd21c9b046';

async function checkLayerVariables() {
  const client = await getSupabaseAdmin();
  
  if (!client) {
    console.error('Supabase not configured');
    process.exit(1);
  }

  // Get draft layers
  const { data, error } = await client
    .from('page_layers')
    .select('*')
    .eq('page_id', pageId)
    .eq('is_published', false)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.error('Error fetching layers:', error);
    process.exit(1);
  }

  if (!data || !data.layers) {
    console.log('No layers found');
    process.exit(0);
  }

  // Recursively find all text and heading layers with variables.text
  function findTextLayers(layers: Layer[], path = ''): any[] {
    const results: any[] = [];
    
    for (const layer of layers) {
      const currentPath = path ? `${path} > ${layer.name}` : layer.name;
      
      if (['text', 'heading'].includes(layer.name) && layer.variables?.text) {
        results.push({
          id: layer.id,
          name: layer.name,
          customName: layer.customName || layer.name,
          path: currentPath,
          variableType: layer.variables.text.type,
          data: layer.variables.text.data
        });
      }
      
      if (layer.children && layer.children.length > 0) {
        results.push(...findTextLayers(layer.children, currentPath));
      }
    }
    
    return results;
  }

  const textLayers = findTextLayers(data.layers);
  
  console.log(`Found ${textLayers.length} text/heading layers with variables.text:`);
  console.log('');
  
  for (const layer of textLayers) {
    console.log('Layer:', layer.customName);
    console.log('  Path:', layer.path);
    console.log('  Type:', layer.variableType);
    console.log('  Data:', JSON.stringify(layer.data, null, 2));
    console.log('');
  }

  process.exit(0);
}

checkLayerVariables();
