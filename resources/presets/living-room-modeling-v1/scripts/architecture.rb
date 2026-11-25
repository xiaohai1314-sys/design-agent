# encoding: utf-8
# LivingRoomPreset - 空间硬装架构模块（地面、墙体、吊顶灯槽、阳台推拉门及栏杆）

module LivingRoomPreset
  module Architecture
    def self.build(root_group, opts, mats, tag, errors)
      ents = root_group.entities
      w = opts[:width_mm]
      d = opts[:depth_mm]
      h = opts[:height_mm]
      wt = opts[:wall_thickness_mm]
      include_balcony = opts[:include_balcony]

      # 1. 客厅地面与踢脚线
      begin
        LivingRoomPreset.add_box(ents, 0, 0, -120, w, d, 120, mats[:floor], tag, 'FloorSlab')
        # 左右与后侧踢脚线
        LivingRoomPreset.add_box(ents, 0, 0, 0, 18, d, 80, mats[:cabinet_body], tag, 'Skirting_Left')
        LivingRoomPreset.add_box(ents, w - 18, 0, 0, 18, d, 80, mats[:cabinet_body], tag, 'Skirting_Right')
        LivingRoomPreset.add_box(ents, 0, 0, 0, w, 18, 80, mats[:cabinet_body], tag, 'Skirting_Back')
      rescue => e
        errors << "arch_floor: #{e.message}"
      end

      # 2. 左右纵墙与后侧端墙（x=0 沙发墙, x=w 电视背景墙）
      begin
        # 左侧沙发墙
        LivingRoomPreset.add_box(ents, -wt, -wt, 0, wt, d + wt * 2, h, mats[:wall], tag, 'Wall_SofaSide')
        # 右侧电视墙
        LivingRoomPreset.add_box(ents, w, -wt, 0, wt, d + wt * 2, h, mats[:wall], tag, 'Wall_TVSide')
        # 后侧端墙（y=0，左侧留出 1100mm 入户/过道垭口）
        passage_w = [1100.0, w * 0.24].min
        LivingRoomPreset.add_box(ents, passage_w, -wt, 0, w - passage_w, wt, h, mats[:wall], tag, 'Wall_EntrySide')
        # 入户过道门洞过梁
        LivingRoomPreset.add_box(ents, 0, -wt, 2350, passage_w, wt, h - 2350, mats[:wall], tag, 'Lintel_Entry')
      rescue => e
        errors << "arch_walls: #{e.message}"
      end

      # 3. 南向阳台玻璃推拉门墙体与阳角框（y=d）
      begin
        side_pier = 420.0
        door_w = [w - side_pier * 2, 1600.0].max
        door_x0 = (w - door_w) * 0.5
        door_h = [2450.0, h - 320.0].min

        # 左右窗垛与顶部过梁
        LivingRoomPreset.add_box(ents, 0, d, 0, door_x0, wt, h, mats[:wall], tag, 'Wall_BalconyLeft')
        LivingRoomPreset.add_box(ents, door_x0 + door_w, d, 0, w - (door_x0 + door_w), wt, h, mats[:wall], tag, 'Wall_BalconyRight')
        LivingRoomPreset.add_box(ents, door_x0, d, door_h, door_w, wt, h - door_h, mats[:wall], tag, 'Lintel_Balcony')

        # 铝合金门外框与三联动玻璃扇
        frame_t = 55.0
        LivingRoomPreset.add_box(ents, door_x0, d + 60, 0, frame_t, 90, door_h, mats[:metal], tag, 'SlidingFrame_L')
        LivingRoomPreset.add_box(ents, door_x0 + door_w - frame_t, d + 60, 0, frame_t, 90, door_h, mats[:metal], tag, 'SlidingFrame_R')
        LivingRoomPreset.add_box(ents, door_x0, d + 60, door_h - frame_t, door_w, 90, frame_t, mats[:metal], tag, 'SlidingFrame_Top')

        panel_w = door_w / 3.0
        3.times do |idx|
          px = door_x0 + idx * panel_w
          py = d + 65 + (idx == 1 ? 26 : 0)
          # 玻璃扇竖框与通透玻璃
          LivingRoomPreset.add_box(ents, px, py, 0, 38, 32, door_h - frame_t, mats[:metal], tag, "SashStile_#{idx}_L")
          LivingRoomPreset.add_box(ents, px + panel_w - 38, py, 0, 38, 32, door_h - frame_t, mats[:metal], tag, "SashStile_#{idx}_R")
          LivingRoomPreset.add_box(ents, px + 38, py + 10, 45, panel_w - 76, 12, door_h - frame_t - 75, mats[:glass], tag, "SlidingGlass_#{idx}")
        end
      rescue => e
        errors << "arch_balcony_door: #{e.message}"
      end

      # 4. 悬浮双眼皮吊顶与线性灯槽
      begin
        soffit_drop = 220.0
        soffit_w = 550.0
        # 顶板（留出高处做层次感，不遮挡顶光）
        LivingRoomPreset.add_box(ents, 0, 0, h, w, d, 80, mats[:ceiling], tag, 'Ceiling_Base')
        # 四周跌级吊顶环
        LivingRoomPreset.add_box(ents, 0, 0, h - soffit_drop, soffit_w, d, soffit_drop, mats[:ceiling], tag, 'Soffit_Left')
        LivingRoomPreset.add_box(ents, w - soffit_w, 0, h - soffit_drop, soffit_w, d, soffit_drop, mats[:ceiling], tag, 'Soffit_Right')
        LivingRoomPreset.add_box(ents, soffit_w, 0, h - soffit_drop, w - soffit_w * 2, soffit_w, soffit_drop, mats[:ceiling], tag, 'Soffit_Back')
        LivingRoomPreset.add_box(ents, soffit_w, d - soffit_w, h - soffit_drop, w - soffit_w * 2, soffit_w, soffit_drop, mats[:ceiling], tag, 'Soffit_Front')
        # 内凹灯带槽指示条
        LivingRoomPreset.add_box(ents, soffit_w - 15, soffit_w - 15, h - 35, w - (soffit_w - 15) * 2, 24, 20, mats[:cove_light], tag, 'CoveLight_Back')
        LivingRoomPreset.add_box(ents, soffit_w - 15, soffit_w - 15, h - 35, 24, d - (soffit_w - 15) * 2, 20, mats[:cove_light], tag, 'CoveLight_Left')
        LivingRoomPreset.add_box(ents, w - soffit_w - 9, soffit_w - 15, h - 35, 24, d - (soffit_w - 15) * 2, 20, mats[:cove_light], tag, 'CoveLight_Right')
      rescue => e
        errors << "arch_ceiling: #{e.message}"
      end

      # 5. 外延景观阳台地台与玻璃护栏
      if include_balcony
        begin
          bal_d = 1500.0
          LivingRoomPreset.add_box(ents, -wt, d + wt, -140, w + wt * 2, bal_d, 130, mats[:feature_stone], tag, 'Balcony_Slab')
          LivingRoomPreset.add_box(ents, 0, d + wt + bal_d - 90, -10, w, 90, 120, mats[:wall], tag, 'Balcony_Curb')
          LivingRoomPreset.add_box(ents, 0, d + wt + bal_d - 52, 110, w, 16, 1020, mats[:glass], tag, 'Balcony_GlassRail')
          LivingRoomPreset.add_box(ents, 0, d + wt + bal_d - 64, 1130, w, 40, 35, mats[:metal], tag, 'Balcony_Handrail')
        rescue => e
          errors << "arch_balcony_ext: #{e.message}"
        end
      end
    end
  end
end
