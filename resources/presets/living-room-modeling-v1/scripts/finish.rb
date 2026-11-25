# encoding: utf-8
# LivingRoomPreset - 材质与贴图配置模块

module LivingRoomPreset
  module Finish
    PALETTES = {
      'modern_minimal' => {
        floor: { rgb: [198, 166, 128], tex: 'oak_wood.png', tile_mm: 1200 },
        wall: { rgb: [238, 236, 232], tex: 'microcement_plaster.png', tile_mm: 1800 },
        ceiling: { rgb: [248, 248, 246], tex: nil, tile_mm: 1000 },
        feature_stone: { rgb: [224, 222, 218], tex: 'terrazzo_stone.png', tile_mm: 1200 },
        grille_wood: { rgb: [98, 68, 48], tex: 'walnut_wood.png', tile_mm: 600 },
        sofa_fabric: { rgb: [216, 212, 204], tex: 'linen_fabric.png', tile_mm: 400 },
        rug: { rgb: [204, 198, 188], tex: 'boucle_rug.png', tile_mm: 600 },
        accent_chair: { rgb: [164, 102, 62], tex: 'linen_fabric.png', tile_mm: 400 },
        metal: { rgb: [42, 44, 48], tex: nil, tile_mm: 400 },
        cabinet_body: { rgb: [232, 229, 224], tex: nil, tile_mm: 600 },
        glass: { rgb: [188, 214, 226], alpha: 0.32 },
        tv_screen: { rgb: [20, 22, 26], tex: nil, tile_mm: 500 },
        cove_light: { rgb: [255, 244, 218], tex: nil, tile_mm: 500 },
        plant_leaf: { rgb: [72, 114, 68], tex: nil, tile_mm: 400 },
        ceramic: { rgb: [236, 232, 224], tex: nil, tile_mm: 400 },
        art_frame: { rgb: [52, 48, 44], tex: nil, tile_mm: 400 },
        art_canvas: { rgb: [226, 218, 206], tex: 'microcement_plaster.png', tile_mm: 800 }
      },
      'new_chinese' => {
        floor: { rgb: [152, 114, 80], tex: 'walnut_wood.png', tile_mm: 1200 },
        wall: { rgb: [242, 238, 230], tex: 'microcement_plaster.png', tile_mm: 1800 },
        ceiling: { rgb: [248, 246, 241], tex: nil, tile_mm: 1000 },
        feature_stone: { rgb: [229, 225, 217], tex: 'terrazzo_stone.png', tile_mm: 1200 },
        grille_wood: { rgb: [82, 54, 36], tex: 'walnut_wood.png', tile_mm: 600 },
        sofa_fabric: { rgb: [212, 206, 194], tex: 'linen_fabric.png', tile_mm: 400 },
        rug: { rgb: [192, 185, 174], tex: 'boucle_rug.png', tile_mm: 600 },
        accent_chair: { rgb: [108, 72, 48], tex: 'walnut_wood.png', tile_mm: 500 },
        metal: { rgb: [122, 98, 62], tex: nil, tile_mm: 400 },
        cabinet_body: { rgb: [88, 58, 38], tex: 'walnut_wood.png', tile_mm: 600 },
        glass: { rgb: [196, 214, 222], alpha: 0.34 },
        tv_screen: { rgb: [18, 20, 24], tex: nil, tile_mm: 500 },
        cove_light: { rgb: [255, 240, 206], tex: nil, tile_mm: 500 },
        plant_leaf: { rgb: [64, 104, 62], tex: nil, tile_mm: 400 },
        ceramic: { rgb: [220, 214, 202], tex: nil, tile_mm: 400 },
        art_frame: { rgb: [62, 42, 28], tex: nil, tile_mm: 400 },
        art_canvas: { rgb: [214, 208, 198], tex: 'linen_fabric.png', tile_mm: 800 }
      },
      'wabi_wood' => {
        floor: { rgb: [208, 182, 148], tex: 'oak_wood.png', tile_mm: 1200 },
        wall: { rgb: [232, 224, 212], tex: 'microcement_plaster.png', tile_mm: 1600 },
        ceiling: { rgb: [238, 232, 222], tex: nil, tile_mm: 1000 },
        feature_stone: { rgb: [220, 212, 198], tex: 'microcement_plaster.png', tile_mm: 1400 },
        grille_wood: { rgb: [176, 144, 108], tex: 'oak_wood.png', tile_mm: 700 },
        sofa_fabric: { rgb: [226, 220, 210], tex: 'linen_fabric.png', tile_mm: 400 },
        rug: { rgb: [216, 208, 194], tex: 'boucle_rug.png', tile_mm: 600 },
        accent_chair: { rgb: [168, 138, 104], tex: 'oak_wood.png', tile_mm: 500 },
        metal: { rgb: [68, 62, 56], tex: nil, tile_mm: 400 },
        cabinet_body: { rgb: [186, 154, 118], tex: 'oak_wood.png', tile_mm: 700 },
        glass: { rgb: [204, 216, 218], alpha: 0.30 },
        tv_screen: { rgb: [24, 24, 26], tex: nil, tile_mm: 500 },
        cove_light: { rgb: [255, 242, 212], tex: nil, tile_mm: 500 },
        plant_leaf: { rgb: [86, 118, 76], tex: nil, tile_mm: 400 },
        ceramic: { rgb: [212, 200, 184], tex: nil, tile_mm: 400 },
        art_frame: { rgb: [138, 112, 84], tex: nil, tile_mm: 400 },
        art_canvas: { rgb: [224, 216, 202], tex: 'microcement_plaster.png', tile_mm: 800 }
      },
      'light_luxury' => {
        floor: { rgb: [214, 210, 204], tex: 'terrazzo_stone.png', tile_mm: 1200 },
        wall: { rgb: [244, 242, 238], tex: 'microcement_plaster.png', tile_mm: 1800 },
        ceiling: { rgb: [250, 250, 248], tex: nil, tile_mm: 1000 },
        feature_stone: { rgb: [236, 234, 230], tex: 'terrazzo_stone.png', tile_mm: 1500 },
        grille_wood: { rgb: [78, 62, 50], tex: 'walnut_wood.png', tile_mm: 600 },
        sofa_fabric: { rgb: [224, 220, 214], tex: 'linen_fabric.png', tile_mm: 400 },
        rug: { rgb: [210, 206, 200], tex: 'boucle_rug.png', tile_mm: 600 },
        accent_chair: { rgb: [148, 114, 86], tex: 'linen_fabric.png', tile_mm: 400 },
        metal: { rgb: [178, 148, 98], tex: nil, tile_mm: 400 },
        cabinet_body: { rgb: [64, 62, 60], tex: nil, tile_mm: 600 },
        glass: { rgb: [190, 214, 228], alpha: 0.32 },
        tv_screen: { rgb: [16, 18, 22], tex: nil, tile_mm: 500 },
        cove_light: { rgb: [255, 246, 224], tex: nil, tile_mm: 500 },
        plant_leaf: { rgb: [68, 112, 66], tex: nil, tile_mm: 400 },
        ceramic: { rgb: [242, 239, 234], tex: nil, tile_mm: 400 },
        art_frame: { rgb: [168, 140, 92], tex: nil, tile_mm: 400 },
        art_canvas: { rgb: [232, 226, 216], tex: 'microcement_plaster.png', tile_mm: 800 }
      }
    }.freeze

    def self.normalize_style(raw_style)
      key = raw_style.to_s.strip.downcase
      return 'new_chinese' if key.include?('chinese') || key.include?('中式')
      return 'wabi_wood' if key.include?('wabi') || key.include?('侘寂') || key.include?('原木')
      return 'light_luxury' if key.include?('luxury') || key.include?('轻奢')
      'modern_minimal'
    end

    def self.build_materials(model, preset_dir, style_key, errors)
      palette = PALETTES[normalize_style(style_key)] || PALETTES['modern_minimal']
      tex_dir = File.join(preset_dir.to_s, 'textures')
      mats = {}
      palette.each do |slot, spec|
        begin
          name = "LRP_#{style_key}_#{slot}"
          mat = model.materials[name] || model.materials.add(name)
          rgb = spec[:rgb] || [220, 220, 220]
          mat.color = Sketchup::Color.new(rgb[0], rgb[1], rgb[2])
          mat.alpha = spec[:alpha] if spec[:alpha]
          if spec[:tex]
            tex_path = File.join(tex_dir, spec[:tex])
            if File.exist?(tex_path)
              mat.texture = tex_path
              tile = (spec[:tile_mm] || 1000).to_f / 25.4
              mat.texture.size = [tile, tile] if mat.texture
            end
          end
          mats[slot] = mat
        rescue => e
          errors << "material(#{slot}): #{e.message}"
        end
      end
      mats
    end
  end
end
