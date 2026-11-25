# encoding: utf-8
# LivingRoomPreset - 主体定制柜体与家具组团模块（电视墙/电视柜/L型沙发/茶几地毯/单椅落地灯）

module LivingRoomPreset
  module Furniture
    def self.build(millwork_grp, furniture_grp, opts, mats, millwork_tag, furniture_tag, errors)
      w = opts[:width_mm]
      d = opts[:depth_mm]
      h = opts[:height_mm]
      cy = d * 0.50

      # 1. 右侧电视背景墙（木格栅 + 岩板造型板）与悬空电视柜（归入 Millwork 层）
      begin
        ments = millwork_grp.entities
        tv_wall_span = [w * 0.72, d * 0.66].min
        tv_wall_span = [tv_wall_span, 3800.0].min
        y0 = cy - tv_wall_span * 0.5

        # 对称实木格栅区（左右翼）
        grille_zone = 620.0
        slat_pitch = 48.0
        [y0, y0 + tv_wall_span - grille_zone].each_with_index do |zy, z_idx|
          LivingRoomPreset.add_box(ments, w - 28, zy, 0, 28, grille_zone, h - 220, mats[:cabinet_body], millwork_tag, "TV_Backboard_#{z_idx}")
          count = (grille_zone / slat_pitch).floor
          count.times do |i|
            sy = zy + 8 + i * slat_pitch
            LivingRoomPreset.add_box(ments, w - 52, sy, 0, 24, 24, h - 220, mats[:grille_wood], millwork_tag, "TV_Slat_#{z_idx}_#{i}")
          end
        end

        # 中段岩板主造型板
        stone_w = tv_wall_span - grille_zone * 2
        LivingRoomPreset.add_box(ments, w - 64, y0 + grille_zone, 0, 64, stone_w, h - 220, mats[:feature_stone], millwork_tag, 'TV_FeatureStone')

        # 悬空电视柜（底部离地 220mm，总高 320mm，进深 420mm）
        console_len = [tv_wall_span - 240.0, 2800.0].max
        console_y = cy - console_len * 0.5
        LivingRoomPreset.add_box(ments, w - 460, console_y, 220, 396, console_len, 285, mats[:cabinet_body], millwork_tag, 'TV_ConsoleBody')
        LivingRoomPreset.add_box(ments, w - 472, console_y - 10, 505, 408, console_len + 20, 28, mats[:feature_stone], millwork_tag, 'TV_ConsoleTop')

        # 超薄大屏 OLED 电视机（75寸约 1680×960mm）
        tv_len = 1680.0
        tv_h = 960.0
        LivingRoomPreset.add_box(ments, w - 115, cy - tv_len * 0.5, 780, 36, tv_len, tv_h, mats[:metal], millwork_tag, 'TV_Bezel')
        LivingRoomPreset.add_box(ments, w - 122, cy - (tv_len - 24) * 0.5, 792, 10, tv_len - 24, tv_h - 24, mats[:tv_screen], millwork_tag, 'TV_Screen')
      rescue => e
        errors << "furniture_tv_wall: #{e.message}"
      end

      return unless opts[:include_furniture]

      fents = furniture_grp.entities

      # 2. 地面编制大地毯
      begin
        rug_w = [w * 0.56, 2600.0].min
        rug_d = [d * 0.56, 3600.0].min
        rug_x = [260.0, (w - rug_w) * 0.44].max
        LivingRoomPreset.add_box(fents, rug_x, cy - rug_d * 0.5, 0, rug_w, rug_d, 14, mats[:rug], furniture_tag, 'AreaRug')
      rescue => e
        errors << "furniture_rug: #{e.message}"
      end

      # 3. L 型现代模块沙发（贴近左侧墙 x=140，朝向右侧电视）
      begin
        sofa_len = [d * 0.52, 3300.0].min
        sofa_len = [sofa_len, 2600.0].max
        sofa_depth = 960.0
        sx = 130.0
        sy = cy - sofa_len * 0.5

        # 金属纤细沙发脚（高 130mm）
        [sx + 80, sx + sofa_depth - 110].each do |lx|
          [sy + 90, sy + sofa_len - 120].each do |ly|
            LivingRoomPreset.add_box(fents, lx, ly, 0, 32, 32, 130, mats[:metal], furniture_tag, 'Sofa_Leg')
          end
        end

        # 底座框架与背板（背板高度 740mm）
        LivingRoomPreset.add_box(fents, sx, sy, 130, sofa_depth, sofa_len, 160, mats[:sofa_fabric], furniture_tag, 'Sofa_Base')
        LivingRoomPreset.add_box(fents, sx, sy, 290, 210, sofa_len, 470, mats[:sofa_fabric], furniture_tag, 'Sofa_BackFrame')
        # 两端扶手
        LivingRoomPreset.add_box(fents, sx, sy, 290, sofa_depth, 180, 310, mats[:sofa_fabric], furniture_tag, 'Sofa_Arm_Back')
        LivingRoomPreset.add_box(fents, sx, sy + sofa_len - 180, 290, sofa_depth, 180, 310, mats[:sofa_fabric], furniture_tag, 'Sofa_Arm_Front')

        # 三座软包坐垫与靠垫
        inner_len = sofa_len - 360.0
        seg_len = (inner_len - 20.0) / 3.0
        3.times do |i|
          cy_seg = sy + 180 + i * (seg_len + 10)
          LivingRoomPreset.add_box(fents, sx + 215, cy_seg, 290, sofa_depth - 220, seg_len, 150, mats[:sofa_fabric], furniture_tag, "Sofa_Cushion_#{i}")
          LivingRoomPreset.add_box(fents, sx + 215, cy_seg + 15, 440, 175, seg_len - 30, 370, mats[:sofa_fabric], furniture_tag, "Sofa_Pillow_#{i}")
        end

        # 靠近阳台侧贵妃榻延伸段（Chaise Lounge）
        chaise_x = sx + sofa_depth
        chaise_ext = 720.0
        LivingRoomPreset.add_box(fents, chaise_x, sy + sofa_len - 180 - seg_len, 130, chaise_ext, seg_len, 160, mats[:sofa_fabric], furniture_tag, 'Sofa_Chaise_Base')
        LivingRoomPreset.add_box(fents, chaise_x, sy + sofa_len - 180 - seg_len, 290, chaise_ext - 15, seg_len, 150, mats[:sofa_fabric], furniture_tag, 'Sofa_Chaise_Cushion')
        LivingRoomPreset.add_box(fents, chaise_x + chaise_ext - 70, sy + sofa_len - 180 - seg_len + 40, 0, 32, 32, 130, mats[:metal], furniture_tag, 'Sofa_Chaise_Leg')
      rescue => e
        errors << "furniture_sofa: #{e.message}"
      end

      # 4. 双层组合茶几（位于沙发与电视柜之间）
      begin
        ct_w = 880.0
        ct_d = 1280.0
        ct_x = w * 0.48 - ct_w * 0.5
        ct_y = cy - ct_d * 0.5 - 120.0
        # 主石材矮台
        LivingRoomPreset.add_box(fents, ct_x, ct_y, 14, ct_w, ct_d, 260, mats[:feature_stone], furniture_tag, 'CoffeeTable_Base')
        # 上叠实木托盘桌面
        LivingRoomPreset.add_box(fents, ct_x + 180, ct_y + ct_d - 420, 274, 620, 620, 110, mats[:grille_wood], furniture_tag, 'CoffeeTable_SubTop')
        # 金属支腿
        LivingRoomPreset.add_box(fents, ct_x + 210, ct_y + ct_d - 40, 14, 24, 24, 260, mats[:metal], furniture_tag, 'CoffeeTable_Leg1')
        LivingRoomPreset.add_box(fents, ct_x + 760, ct_y + ct_d - 40, 14, 24, 24, 260, mats[:metal], furniture_tag, 'CoffeeTable_Leg2')
      rescue => e
        errors << "furniture_coffee_table: #{e.message}"
      end

      # 5. 设计师休闲单椅 + 极简落地灯
      begin
        ac_x = w * 0.56
        ac_y = cy - 1450.0
        LivingRoomPreset.add_box(fents, ac_x, ac_y, 14, 680, 680, 180, mats[:metal], furniture_tag, 'LoungeChair_Frame')
        LivingRoomPreset.add_box(fents, ac_x + 30, ac_y + 30, 194, 620, 620, 165, mats[:accent_chair], furniture_tag, 'LoungeChair_Seat')
        LivingRoomPreset.add_box(fents, ac_x + 40, ac_y + 30, 359, 600, 150, 360, mats[:accent_chair], furniture_tag, 'LoungeChair_Back')

        # 落地灯（沙发靠近阳台端角隅）
        fl_x = 320.0
        fl_y = cy + [d * 0.28, 1750.0].min
        LivingRoomPreset.add_box(fents, fl_x, fl_y, 14, 340, 340, 28, mats[:metal], furniture_tag, 'FloorLamp_Base')
        LivingRoomPreset.add_box(fents, fl_x + 158, fl_y + 158, 42, 24, 24, 1580, mats[:metal], furniture_tag, 'FloorLamp_Stem')
        LivingRoomPreset.add_box(fents, fl_x + 65, fl_y + 65, 1620, 210, 210, 240, mats[:cove_light], furniture_tag, 'FloorLamp_Shade')
      rescue => e
        errors << "furniture_chair_lamp: #{e.message}"
      end
    end
  end
end
