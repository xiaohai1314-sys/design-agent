# encoding: utf-8
# LivingRoomPreset - 软装陈设模块（电动窗帘盒与帘幔、沙发背景装饰画、琴叶榕绿植、茶具书册）

module LivingRoomPreset
  module Decor
    def self.build(decor_grp, opts, mats, decor_tag, errors)
      return unless opts[:include_decor]

      dents = decor_grp.entities
      w = opts[:width_mm]
      d = opts[:depth_mm]
      h = opts[:height_mm]
      cy = d * 0.50

      # 1. 沙发背景墙极简双联装饰画（居于沙发中线上方 1450~2350mm）
      begin
        art_w = 820.0
        art_h = 1040.0
        art_z = 1320.0
        gap = 140.0
        y_start = cy - art_w - gap * 0.5
        2.times do |i|
          ay = y_start + i * (art_w + gap)
          LivingRoomPreset.add_box(dents, 0, ay, art_z, 34, art_w, art_h, mats[:art_frame], decor_tag, "WallArt_Frame_#{i}")
          LivingRoomPreset.add_box(dents, 34, ay + 24, art_z + 24, 10, art_w - 48, art_h - 48, mats[:art_canvas], decor_tag, "WallArt_Canvas_#{i}")
        end
      rescue => e
        errors << "decor_artwork: #{e.message}"
      end

      # 2. 南向落地窗两侧布艺与纱帘（垂至地面 15mm，留出中部采光）
      begin
        curtain_w = 680.0
        curtain_h = h - 235.0
        # 左侧与右侧堆叠垂褶窗帘
        [45.0, w - curtain_w - 45.0].each_with_index do |cx, idx|
          4.times do |fold|
            fx = cx + fold * (curtain_w / 4.0)
            depth_off = fold.even? ? 120.0 : 165.0
            LivingRoomPreset.add_box(dents, fx, d - depth_off - 40, 15, (curtain_w / 4.0) - 8, 95, curtain_h, mats[:sofa_fabric], decor_tag, "Curtain_#{idx}_#{fold}")
          end
        end
      rescue => e
        errors << "decor_curtain: #{e.message}"
      end

      # 3. 阳台采光角陶瓷花盆与大型室内绿植
      begin
        px = w - 680.0
        py = d - 580.0
        # 陶瓷花盆 + 土壤 + 分层枝叶体块
        LivingRoomPreset.add_box(dents, px, py, 0, 360, 360, 420, mats[:ceramic], decor_tag, 'Planter_Pot')
        LivingRoomPreset.add_box(dents, px + 165, py + 165, 420, 30, 30, 620, mats[:grille_wood], decor_tag, 'Planter_Trunk')
        [[60, 60, 820, 280, 280, 240], [110, -20, 980, 260, 260, 220], [-20, 90, 1040, 240, 240, 260]].each_with_index do |canopy, idx|
          LivingRoomPreset.add_box(
            dents,
            px + canopy[0],
            py + canopy[1],
            canopy[2],
            canopy[3],
            canopy[4],
            canopy[5],
            mats[:plant_leaf],
            decor_tag,
            "Planter_Canopy_#{idx}"
          )
        end
      rescue => e
        errors << "decor_plant: #{e.message}"
      end

      # 4. 茶几精装画册与茶具托盘小品
      begin
        ct_x = w * 0.48 - 440.0
        ct_y = cy - 640.0 - 120.0
        LivingRoomPreset.add_box(dents, ct_x + 120, ct_y + 190, 274, 240, 320, 28, mats[:art_canvas], decor_tag, 'CoffeeBook_Bottom')
        LivingRoomPreset.add_box(dents, ct_x + 135, ct_y + 205, 302, 210, 280, 24, mats[:art_frame], decor_tag, 'CoffeeBook_Top')
        LivingRoomPreset.add_box(dents, ct_x + 420, ct_y + 260, 274, 280, 220, 22, mats[:ceramic], decor_tag, 'TeaTray')
        LivingRoomPreset.add_box(dents, ct_x + 480, ct_y + 320, 296, 95, 95, 78, mats[:ceramic], decor_tag, 'TeaPot')
      rescue => e
        errors << "decor_props: #{e.message}"
      end
    end
  end
end
